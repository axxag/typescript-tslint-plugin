import * as eslint from 'eslint'
import * as path from 'path'
import * as ts_module from 'typescript/lib/tsserverlibrary'

import { ESLINT_ERROR_CODE, ESLINT_ERROR_SOURCE } from './config'
import { ConfigFileWatcher } from './configFileWatcher'
import { Logger } from './logger'
import { EsLintRunner, RunResult, toPackageManager } from './runner'
import {
  filterProblemsForFile,
  getNonOverlappingReplacements
} from './runner/failures'
import { ConfigurationManager } from './settings'

const isEsLintLanguageServiceMarker = Symbol(
  "__isEsLintLanguageServiceMarker__"
);

interface Problem {
  failure: eslint.Linter.LintMessage;
  fixable: boolean;
}

class EsLintFixId {
  public static fromFailure(failure: eslint.Linter.LintMessage) {
    return `eslint:${failure.ruleId}`;
  }

  public static toRuleName(fixId: {}): undefined | string {
    if (typeof fixId !== "string" || !fixId.startsWith("eslint:")) {
      return undefined;
    }
    return fixId.replace(/^eslint:/, "");
  }
}

class ProblemMap {
  private readonly _map = new Map<string, Problem>();

  public get(start: number, end: number) {
    return this._map.get(this.key(start, end));
  }

  public set(start: number, end: number, problem: Problem): void {
    this._map.set(this.key(start, end), problem);
  }

  public values() {
    return this._map.values();
  }

  // key to identify a rule failure
  private key(start: number, end: number): string {
    return `[${start},${end}]`;
  }
}

export class ESLintPlugin {
  private readonly codeFixActions = new Map<string, ProblemMap>();
  private readonly configFileWatcher: ConfigFileWatcher;
  private readonly runner: EsLintRunner;

  public constructor(
    private readonly ts: typeof ts_module,
    private readonly languageServiceHost: ts_module.LanguageServiceHost,
    private readonly logger: Logger,
    private readonly project: ts_module.server.Project,
    private readonly configurationManager: ConfigurationManager
  ) {
    this.logger.info("loaded");

    this.runner = new EsLintRunner((message) => {
      this.logger.info(message);
    });

    this.configFileWatcher = new ConfigFileWatcher(ts, () => {
      this.logger.info("ESlint file changed");
      this.project.refreshDiagnostics();
    });

    this.configurationManager.onUpdatedConfig(() => {
      this.logger.info("TSConfig configuration changed");
      project.refreshDiagnostics();
    });
  }

  public decorate(languageService: ts.LanguageService) {
    if ((languageService as any)[isEsLintLanguageServiceMarker]) {
      // Already decorated
      return;
    }

    const oldGetSupportedCodeFixes = this.ts.getSupportedCodeFixes.bind(
      this.ts
    );
    this.ts.getSupportedCodeFixes = (): string[] => {
      return [...oldGetSupportedCodeFixes(), "" + ESLINT_ERROR_CODE];
    };

    const intercept: Partial<ts.LanguageService> = Object.create(null);

    const oldGetSemanticDiagnostics = languageService.getSemanticDiagnostics.bind(
      languageService
    );
    intercept.getSemanticDiagnostics = (...args) => {
      return this.getSemanticDiagnostics(oldGetSemanticDiagnostics, ...args);
    };

    const oldGetCodeFixesAtPosition = languageService.getCodeFixesAtPosition.bind(
      languageService
    );
    intercept.getCodeFixesAtPosition = (
      ...args
    ): ReadonlyArray<ts.CodeFixAction> => {
      return this.getCodeFixesAtPosition(oldGetCodeFixesAtPosition, ...args);
    };

    const oldGetCombinedCodeFix = languageService.getCombinedCodeFix.bind(
      languageService
    );
    intercept.getCombinedCodeFix = (...args): ts_module.CombinedCodeActions => {
      return this.getCombinedCodeFix(oldGetCombinedCodeFix, ...args);
    };

    return new Proxy(languageService, {
      get: (
        target: any,
        property: keyof ts.LanguageService &
          typeof isEsLintLanguageServiceMarker
      ) => {
        if (property === isEsLintLanguageServiceMarker) {
          return true;
        }
        return intercept[property] || target[property];
      },
    });
  }

  private getSemanticDiagnostics(
    delegate: (fileName: string) => ts_module.Diagnostic[],
    fileName: string
  ): ts_module.Diagnostic[] {
    const diagnostics = delegate(fileName);

    const config = this.configurationManager.config;
    if (diagnostics.length > 0 && config.suppressWhileTypeErrorsPresent) {
      return diagnostics;
    }

    try {
      this.logger.info(
        `Computing eslint semantic diagnostics for '${fileName}'`
      );

      if (this.codeFixActions.has(fileName)) {
        this.codeFixActions.delete(fileName);
      }

      if (config.ignoreDefinitionFiles && fileName.endsWith(".d.ts")) {
        return diagnostics;
      }

      let result: RunResult;
      try {
        // protect against eslint crashes
        result = this.runner.runEsLint(fileName, this.getProgram(), {
          configFile: config.configFile,
          ignoreDefinitionFiles: config.ignoreDefinitionFiles,
          jsEnable: config.jsEnable,
          exclude: config.exclude
            ? Array.isArray(config.exclude)
              ? config.exclude
              : [config.exclude]
            : [],
          packageManager: toPackageManager(config.packageManager),
        });
        if (result.configFilePath) {
          this.configFileWatcher.ensureWatching(result.configFilePath);
        }
      } catch (err) {
        let errorMessage = `unknown error`;
        if (typeof err.message === "string" || err.message instanceof String) {
          errorMessage = err.message as string;
        }
        this.logger.info("eslint error " + errorMessage);
        return diagnostics;
      }

      const program = this.getProgram();
      const file = program.getSourceFile(fileName)!;
      if (result.warnings) {
        const defaultTsconfigJsonPath = path.join(
          program.getCurrentDirectory(),
          "eslint.json"
        );
        if (
          (result.configFilePath &&
            this.ts.sys.fileExists(result.configFilePath)) ||
          this.ts.sys.fileExists(defaultTsconfigJsonPath)
        ) {
          // If we have a config file, the user likely wanted to lint. The fact that linting has a
          // warning should be reported to them.
          for (const warning of result.warnings) {
            diagnostics.unshift({
              file,
              start: 0,
              length: 1,
              category: this.ts.DiagnosticCategory.Warning,
              source: ESLINT_ERROR_SOURCE,
              code: ESLINT_ERROR_CODE,
              messageText: warning,
            });
          }
        } else {
          // If we have not found a config file, then we don't want to annoy users by generating warnings
          // about eslint not being installed or misconfigured. In many cases, the user is opening a
          // file/project that was not intended to be linted.
          for (const warning of result.warnings) {
            this.logger.info(`[eslint] ${warning}`);
          }
        }
      }
      const eslintProblems = filterProblemsForFile(fileName, result.lintResult);
      for (const problem of eslintProblems) {
        diagnostics.push(this.makeDiagnostic(problem, file));
        this.recordCodeAction(problem, file);
      }
    } catch (e) {
      this.logger.info(`eslint-language service error: ${e.toString()}`);
      this.logger.info(`Stack trace: ${e.stack}`);
    }

    return diagnostics;
  }

  private getCodeFixesAtPosition(
    delegate: ts.LanguageService["getCodeFixesAtPosition"],
    fileName: string,
    start: number,
    end: number,
    errorCodes: ReadonlyArray<number>,
    formatOptions: ts.FormatCodeSettings,
    userPreferences: ts.UserPreferences
  ): ReadonlyArray<ts.CodeFixAction> {
    const fixes = Array.from(
      delegate(fileName, start, end, errorCodes, formatOptions, userPreferences)
    );

    if (
      this.configurationManager.config.suppressWhileTypeErrorsPresent &&
      fixes.length > 0
    ) {
      return fixes;
    }

    this.logger.info(`getCodeFixes ${errorCodes[0]}`);
    this.logger.info(JSON.stringify(fixes));

    const documentFixes = this.codeFixActions.get(fileName);
    if (documentFixes) {
      const problem = documentFixes.get(start, end);
      if (problem && problem.failure.ruleId) {
        if (problem.fixable) {
          const fix = problem.failure.fix;
          if (fix) {
            const codeFixAction = this.getRuleFailureQuickFix(
              problem.failure,
              fileName
            );
            fixes.push(codeFixAction);

            const fixAll = this.getRuleFailureFixAllQuickFix(
              problem.failure.ruleId,
              documentFixes,
              fileName
            );
            if (fixAll) {
              codeFixAction.fixId = EsLintFixId.fromFailure(problem.failure);
              codeFixAction.fixAllDescription = `Fix all '${problem.failure.ruleId}'`;
            }

            fixes.push(
              this.getFixAllAutoFixableQuickFix(documentFixes, fileName)
            );
          }
        }

        fixes.push(
          this.getDisableRuleQuickFix(
            problem.failure,
            fileName,
            this.getProgram().getSourceFile(fileName)!
          )
        );
      }
    }

    return fixes;
  }

  private getCombinedCodeFix(
    delegate: ts.LanguageService["getCombinedCodeFix"],
    scope: ts_module.CombinedCodeFixScope,
    fixId: {},
    formatOptions: ts_module.FormatCodeSettings,
    preferences: ts_module.UserPreferences
  ): ts_module.CombinedCodeActions {
    const ruleName = EsLintFixId.toRuleName(fixId);
    if (!ruleName) {
      return delegate(scope, fixId, formatOptions, preferences);
    }

    const documentFixes = this.codeFixActions.get(scope.fileName);
    if (documentFixes) {
      const fixAll = this.getRuleFailureFixAllQuickFix(
        ruleName,
        documentFixes,
        scope.fileName
      );
      if (fixAll) {
        return {
          changes: fixAll.changes,
          commands: fixAll.commands,
        };
      }
    }

    return { changes: [] };
  }

  private recordCodeAction(
    failure: eslint.Linter.LintMessage,
    file: ts.SourceFile
  ) {
    // eslint can return a fix with an empty replacements array, these fixes are ignored
    const fixable = !!(failure.fix && !replacementsAreEmpty(failure.fix));

    let documentAutoFixes = this.codeFixActions.get(file.fileName);
    if (!documentAutoFixes) {
      documentAutoFixes = new ProblemMap();
      this.codeFixActions.set(file.fileName, documentAutoFixes);
    }
    const { start, end } = this.getTextSpan(file, failure);
    documentAutoFixes.set(start, end, { failure, fixable });
  }

  private getRuleFailureQuickFix(
    failure: eslint.Linter.LintMessage,
    fileName: string
  ): ts_module.CodeFixAction {
    return {
      description: `Fix: ${failure.message}`,
      fixName: `eslint:${failure.ruleId}`,
      changes: [failureToFileTextChange(failure, fileName)],
    };
  }

  /**
   * Generate a code action that fixes all instances of ruleName.
   */
  private getRuleFailureFixAllQuickFix(
    ruleName: string,
    problems: ProblemMap,
    fileName: string
  ): ts_module.CodeFixAction | undefined {
    const changes: ts_module.FileTextChanges[] = [];

    for (const problem of problems.values()) {
      if (problem.fixable) {
        if (problem.failure.ruleId === ruleName) {
          changes.push(failureToFileTextChange(problem.failure, fileName));
        }
      }
    }

    // No need for this action if there's only one instance.
    if (changes.length < 2) {
      return undefined;
    }

    return {
      description: `Fix all '${ruleName}'`,
      fixName: `eslint:fix-all:${ruleName}`,
      changes,
    };
  }

  private getDisableRuleQuickFix(
    failure: eslint.Linter.LintMessage,
    fileName: string,
    file: ts_module.SourceFile
  ): ts_module.CodeFixAction {
    const line = failure.line - 1;
    const lineStarts = file.getLineStarts();
    const lineStart = lineStarts[line];
    let prefix = "";
    const snapshot = this.languageServiceHost.getScriptSnapshot(fileName);
    if (snapshot) {
      const lineEnd =
        line < lineStarts.length - 1 ? lineStarts[line + 1] : file.end;
      const lineText = snapshot.getText(lineStart, lineEnd);
      const leadingSpace = lineText.match(/^([ \t]+)/);
      if (leadingSpace) {
        prefix = leadingSpace[0];
      }
    }

    return {
      description: `Disable rule '${failure.ruleId}'`,
      fixName: `eslint:disable:${failure.ruleId}`,
      changes: [
        {
          fileName,
          textChanges: [
            {
              newText: `${prefix}// eslint-disable-next-line ${failure.ruleId}\n`,
              span: { start: lineStart, length: 0 },
            },
          ],
        },
      ],
    };
  }

  private getFixAllAutoFixableQuickFix(
    documentFixes: ProblemMap,
    fileName: string
  ): ts_module.CodeFixAction {
    const allReplacements = getNonOverlappingReplacements(
      Array.from(documentFixes.values())
        .filter((x) => x.fixable)
        .map((x) => x.failure)
    );
    return {
      description: `Fix all auto-fixable eslint failures`,
      fixName: `eslint:fix-all`,
      changes: [
        {
          fileName,
          textChanges: allReplacements.map(convertReplacementToTextChange),
        },
      ],
    };
  }

  private getTextSpan(
    file: ts.SourceFile,
    lintMessage: eslint.Linter.LintMessage
  ) {
    const positionResolver = (
      line?: number,
      column?: number | null
    ): number | null => {
      if (line) {
        let result: number;
        let lineStarts = file.getLineStarts();

        if (line > lineStarts.length) {
          result = file.getLineEndOfPosition(lineStarts[lineStarts.length - 1]);
        } else {
          let lineStart = lineStarts[line - 1];
          let lineEnd = file.getLineEndOfPosition(lineStart);
          line--;

          if (column === null || column === undefined) {
            result = lineEnd;
          } else {
            column--;

            if (column <= file.getLineEndOfPosition(lineStart) - lineStart) {
              result = file.getPositionOfLineAndCharacter(line, column);
            } else {
              result = lineEnd;
            }
          }
        }

        return result;
      } else {
        return null;
      }
    };

    let start = positionResolver(lintMessage.line, lintMessage.column) ?? 0;
    let end =
      positionResolver(lintMessage.endLine, lintMessage.endColumn) ?? start;

    return {
      start,
      length: end - start,
      end,
    };
  }

  private getProgram() {
    return this.project.getLanguageService().getProgram()!;
  }

  private makeDiagnostic(
    failure: eslint.Linter.LintMessage,
    file: ts.SourceFile
  ): ts.Diagnostic {
    const message =
      failure.ruleId !== null
        ? `${failure.message} (${failure.ruleId})`
        : `${failure.message}`;

    const category = this.getDiagnosticCategory(failure);
    const { start, length } = this.getTextSpan(file, failure);
    return {
      file,
      start,
      length,
      messageText: message,
      category,
      source: ESLINT_ERROR_SOURCE,
      code: ESLINT_ERROR_CODE,
    };
  }

  private getDiagnosticCategory(
    failure: eslint.Linter.LintMessage
  ): ts.DiagnosticCategory {
    if (
      this.configurationManager.config.alwaysShowRuleFailuresAsWarnings ||
      typeof this.configurationManager.config
        .alwaysShowRuleFailuresAsWarnings === "undefined"
    ) {
      return this.ts.DiagnosticCategory.Warning;
    }
    if (failure.severity && failure.severity === 2) {
      return this.ts.DiagnosticCategory.Error;
    }
    return this.ts.DiagnosticCategory.Warning;
  }
}

function convertReplacementToTextChange(
  repl: eslint.Rule.Fix
): ts_module.TextChange {
  return {
    newText: repl.text,
    span: { start: repl.range[0], length: repl.range[1] - repl.range[0] },
  };
}

function convertFixToTextChange(fix: eslint.Rule.Fix): ts.TextChange {
  return {
    newText: fix.text,
    span: {
      start: fix.range[0],
      length: fix.range[1] - fix.range[0],
    },
  };
}

function failureToFileTextChange(
  failure: eslint.Linter.LintMessage,
  fileName: string
): ts_module.FileTextChanges {
  const fix = failure.fix;

  return {
    fileName,
    textChanges: fix ? [convertFixToTextChange(fix)] : [],
  };
}

function replacementsAreEmpty(fix: eslint.Rule.Fix | undefined): boolean {
  if (Array.isArray(fix)) {
    return fix.length === 0;
  }
  return false;
}
