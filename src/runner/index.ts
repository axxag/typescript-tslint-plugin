import * as cp from 'child_process'
import * as eslint from 'eslint' // this is a dev dependency only
import * as fs from 'fs'
import * as minimatch from 'minimatch'
import { delimiter, dirname, relative } from 'path'
import * as typescript from 'typescript' // this is a dev dependency only
import * as server from 'vscode-languageserver'

import { MruCache } from './mruCache'

export type PackageManager = "npm" | "pnpm" | "yarn";

export function toPackageManager(
  manager: string | undefined
): PackageManager | undefined {
  switch (manager && manager.toLowerCase()) {
    case "npm":
      return "npm";
    case "pnpm":
      return "pnpm";
    case "yarn":
      return "yarn";
    default:
      return undefined;
  }
}

export interface RunConfiguration {
  readonly allowInlineConfig?: boolean;
  readonly reportUnusedDisableDirectives?: boolean;
  readonly jsEnable: boolean;
  readonly configFile?: string;
  readonly useEslintrc?: boolean;
  readonly ignoreDefinitionFiles: boolean;
  readonly exclude: string[];
  readonly validateWithDefaultConfig?: boolean;
  readonly nodePath?: string;
  readonly packageManager?: PackageManager;
  readonly traceLevel?: "verbose" | "normal";
  readonly workspaceFolderPath?: string;
}

export interface RunResult {
  readonly lintResult: eslint.CLIEngine.LintReport;
  readonly warnings: string[];
  readonly workspaceFolderPath?: string;
  readonly configFilePath?: string;
}

const emptyLintResult: eslint.CLIEngine.LintReport = {
  errorCount: 0,
  warningCount: 0,
  results: [],
  fixableErrorCount: 0,
  fixableWarningCount: 0,
  usedDeprecatedRules: [],
};

const emptyResult: RunResult = {
  lintResult: emptyLintResult,
  warnings: [],
};

export class EsLintRunner {
  private readonly eslintPath2Library = new Map<
    string,
    typeof eslint | undefined
  >();
  private readonly document2LibraryCache = new MruCache<
    () => typeof eslint | undefined
  >(100);

  // map stores undefined values to represent failed resolutions
  private readonly globalPackageManagerPath = new Map<
    PackageManager,
    string | undefined
  >();

  constructor(private readonly trace: (data: string) => void) {}

  public runEsLint(
    filePath: string,
    contents: string | typescript.Program,
    configuration: RunConfiguration
  ): RunResult {
    this.traceMethod("runEsLint", "start");

    const warnings: string[] = [];
    if (!this.document2LibraryCache.has(filePath)) {
      this.loadLibrary(filePath, configuration, warnings);
    }
    this.traceMethod("runEsLint", "Loaded eslint library");

    if (!this.document2LibraryCache.has(filePath)) {
      return emptyResult;
    }

    const library = this.document2LibraryCache.get(filePath)!();
    if (!library) {
      return {
        lintResult: emptyLintResult,
        warnings: [
          getInstallFailureMessage(
            filePath,
            configuration.packageManager || "npm"
          ),
        ],
      };
    }

    this.traceMethod("runEsLint", "About to validate " + filePath);
    return this.doRun(filePath, contents, library, configuration, warnings);
  }

  private traceMethod(method: string, message: string) {
    this.trace(`(${method}) ${message}`);
  }

  private loadLibrary(
    filePath: string,
    configuration: RunConfiguration,
    warningsOutput: string[]
  ): void {
    this.traceMethod("loadLibrary", `trying to load ${filePath}`);
    const getGlobalPath = () =>
      this.getGlobalPackageManagerPath(configuration.packageManager);
    const directory = dirname(filePath);

    let np: string | undefined;
    if (configuration && configuration.nodePath) {
      const exists = fs.existsSync(configuration.nodePath);
      if (exists) {
        np = configuration.nodePath;
      } else {
        warningsOutput.push(
          `The setting 'eslint.nodePath' refers to '${configuration.nodePath}', but this path does not exist. The setting will be ignored.`
        );
      }
    }

    let esLintPath: string;

    if (np) {
      try {
        esLintPath = this.resolveEsLint(np, np!);
        if (esLintPath.length === 0) {
          esLintPath = this.resolveEsLint(getGlobalPath(), directory);
        }
      } catch {
        esLintPath = this.resolveEsLint(getGlobalPath(), directory);
      }
    } else {
      try {
        esLintPath = this.resolveEsLint(undefined, directory);
        if (esLintPath.length === 0) {
          esLintPath = this.resolveEsLint(getGlobalPath(), directory);
        }
      } catch {
        esLintPath = this.resolveEsLint(getGlobalPath(), directory);
      }
    }

    this.traceMethod("loadLibrary", `Resolved eslint to ${esLintPath}`);

    this.document2LibraryCache.set(filePath, () => {
      let library;
      if (!this.eslintPath2Library.has(esLintPath)) {
        try {
          library = require(esLintPath);
        } catch (e) {
          this.eslintPath2Library.set(esLintPath, undefined);
          return;
        }
        this.eslintPath2Library.set(esLintPath, library);
      }
      return this.eslintPath2Library.get(esLintPath);
    });
  }

  private getGlobalPackageManagerPath(
    packageManager: PackageManager = "npm"
  ): string | undefined {
    this.traceMethod(
      "getGlobalPackageManagerPath",
      `Begin - Resolve Global Package Manager Path for: ${packageManager}`
    );

    if (!this.globalPackageManagerPath.has(packageManager)) {
      let path: string | undefined;
      if (packageManager === "npm") {
        path = server.Files.resolveGlobalNodePath(this.trace);
      } else if (packageManager === "yarn") {
        path = server.Files.resolveGlobalYarnPath(this.trace);
      } else if (packageManager === "pnpm") {
        path = cp.execSync("pnpm root -g").toString().trim();
      }
      this.globalPackageManagerPath.set(packageManager, path);
    }
    this.traceMethod(
      "getGlobalPackageManagerPath",
      `Done - Resolve Global Package Manager Path for: ${packageManager}`
    );
    return this.globalPackageManagerPath.get(packageManager);
  }

  private doRun(
    filePath: string,
    contents: string | typescript.Program,
    library: typeof import("eslint"),
    configuration: RunConfiguration,
    warnings: string[]
  ): RunResult {
    this.traceMethod("doRun", `starting validation for ${filePath}`);

    let cwd = configuration.workspaceFolderPath;
    if (!cwd && typeof contents === "object") {
      cwd = contents.getCurrentDirectory();
    }

    if (this.fileIsExcluded(configuration, filePath, cwd)) {
      this.traceMethod("doRun", `No linting: file ${filePath} is excluded`);
      return emptyResult;
    }

    let cwdToRestore: string | undefined;
    if (cwd) {
      this.traceMethod("doRun", `Changed directory to ${cwd}`);
      cwdToRestore = process.cwd();
      process.chdir(cwd);
    }

    try {
      if (isJsDocument(filePath) && !configuration.jsEnable) {
        this.traceMethod(
          "doRun",
          `No linting: a JS document, but js linting is disabled`
        );
        return emptyResult;
      }

      let result: eslint.CLIEngine.LintReport;
      const options: eslint.Linter.FixOptions = {
        filename: filePath,
        fix: false,
        allowInlineConfig: configuration.allowInlineConfig || undefined,
        reportUnusedDisableDirectives:
          configuration.reportUnusedDisableDirectives || undefined,
      };

      // eslint writes warnings using console.warn, capture these warnings and send them to the client
      const originalConsoleWarn = console.warn;
      const captureWarnings = (message?: any) => {
        warnings.push(message);
        originalConsoleWarn(message);
      };
      console.warn = captureWarnings;

      try {
        // clean up if eslint crashes
        const linter = new library.CLIEngine(options);
        this.traceMethod("doRun", `Linting: start linting ${filePath}`);
        result = linter.executeOnFiles([filePath]);
        this.traceMethod("doRun", `Linting: ended linting`);
      } finally {
        console.warn = originalConsoleWarn;
      }

      return {
        lintResult: result,
        warnings,
        workspaceFolderPath: configuration.workspaceFolderPath,
      };
    } finally {
      if (typeof cwdToRestore === "string") {
        process.chdir(cwdToRestore);
      }
    }
  }

  private fileIsExcluded(
    settings: RunConfiguration,
    filePath: string,
    cwd: string | undefined
  ): boolean {
    if (settings.ignoreDefinitionFiles && filePath.endsWith(".d.ts")) {
      return true;
    }
    return settings.exclude.some((pattern) =>
      testForExclusionPattern(filePath, pattern, cwd)
    );
  }

  private resolveEsLint(nodePath: string | undefined, cwd: string): string {
    const nodePathKey = "NODE_PATH";
    const app = ["console.log(require.resolve('eslint'));"].join("");

    const env = process.env;
    const newEnv = Object.create(null);
    Object.keys(env).forEach((key) => (newEnv[key] = env[key]));
    if (nodePath) {
      if (newEnv[nodePathKey]) {
        newEnv[nodePathKey] = nodePath + delimiter + newEnv[nodePathKey];
      } else {
        newEnv[nodePathKey] = nodePath;
      }
      this.traceMethod(
        "resolveEsLint",
        `NODE_PATH value is: ${newEnv[nodePathKey]}`
      );
    }
    newEnv.ELECTRON_RUN_AS_NODE = "1";
    const spanwResults = cp.spawnSync(process.argv0, ["-e", app], {
      cwd,
      env: newEnv,
    });
    return spanwResults.stdout.toString().trim();
  }
}

function testForExclusionPattern(
  filePath: string,
  pattern: string,
  cwd: string | undefined
): boolean {
  if (cwd) {
    // try first as relative
    const relPath = relative(cwd, filePath);
    if (minimatch(relPath, pattern, { dot: true })) {
      return true;
    }
    if (relPath === filePath) {
      return false;
    }
  }

  return minimatch(filePath, pattern, { dot: true });
}

function getInstallFailureMessage(
  filePath: string,
  packageManager: PackageManager
): string {
  const localCommands = {
    npm: "npm install eslint",
    pnpm: "pnpm install eslint",
    yarn: "yarn add eslint",
  };
  const globalCommands = {
    npm: "npm install -g eslint",
    pnpm: "pnpm install -g eslint",
    yarn: "yarn global add eslint",
  };

  return [
    `Failed to load the ESLint library for '${filePath}'`,
    `To use ESLint, please install eslint using \'${localCommands[packageManager]}\' or globally using \'${globalCommands[packageManager]}\'.`,
    "Be sure to restart your editor after installing eslint.",
  ].join("\n");
}

function isJsDocument(filePath: string): boolean {
  return /\.(jsx?|mjs)$/i.test(filePath);
}
