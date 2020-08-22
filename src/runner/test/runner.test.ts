import 'mocha'

import { expect } from 'chai'
import * as eslint from 'eslint'
import * as fs from 'fs'
import * as path from 'path'

import {
  filterProblemsForFile,
  getNonOverlappingReplacements
} from '../failures'
import { EsLintRunner, RunConfiguration } from '../index'

const testDataRoot = path.join(__dirname, "..", "..", "..", "test-data");

const defaultRunConfiguration: RunConfiguration = {
  exclude: [],
  jsEnable: false,
  ignoreDefinitionFiles: true,
};

describe("ESLintRunner", () => {
  describe("runEsLint", () => {
    // Must come first. TS lint only reports warnings once.
    it.skip("should report warnings", () => {
      const filePath = path.join(
        testDataRoot,
        "no-unused-variables",
        "test.ts"
      );
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.errorCount).to.equal(0);
      expect(result.warnings.length).to.equal(2);
    });

    it("should not return any errors for empty file", () => {
      const result = createEsLintRunner().runEsLint(
        "",
        "",
        defaultRunConfiguration
      );
      expect(result.lintResult.errorCount).to.equal(0);
    });

    it("should return an error for test file", () => {
      const folderPath = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(folderPath, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        { ...defaultRunConfiguration, workspaceFolderPath: folderPath }
      );

      expect(result.lintResult.errorCount).to.equal(1);
      expect(result.lintResult.warningCount).to.equal(0);

      const firstFailure = result.lintResult.results[0];
      expect(path.normalize(firstFailure.filePath)).to.equal(filePath);
      expect(firstFailure.messages[0].ruleId).to.equal(
        "@typescript-eslint/array-type"
      );

      const fix = firstFailure.messages[0].fix;
      expect(fix).to.not.equal(undefined);
      expect(fix!.range.length).to.equal(2);
    });

    it("should use correct config for each file", () => {
      const warningFilePath = path.join(testDataRoot, "warnings", "test.ts");
      const warnResult = createEsLintRunner().runEsLint(
        warningFilePath,
        fs.readFileSync(warningFilePath).toString(),
        defaultRunConfiguration
      );

      expect(warnResult.lintResult.errorCount).to.equal(0);
      expect(warnResult.lintResult.warningCount).to.equal(1);

      const errorFilePath = path.join(testDataRoot, "with-eslint", "test.ts");
      const errorResult = createEsLintRunner().runEsLint(
        errorFilePath,
        fs.readFileSync(warningFilePath).toString(),
        defaultRunConfiguration
      );

      expect(errorResult.lintResult.errorCount).to.equal(1);
      expect(errorResult.lintResult.warningCount).to.equal(0);
    });

    it("should not return any errors for excluded file (absolute path)", () => {
      const filePath = path.join(testDataRoot, "with-eslint", "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          ...defaultRunConfiguration,
          exclude: [filePath],
        }
      );

      expect(result.lintResult.errorCount).to.equal(0);
    });

    it("should not return any errors for excluded file (relative path)", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          ...defaultRunConfiguration,
          workspaceFolderPath: root,
          exclude: ["test.ts"],
        }
      );

      expect(result.lintResult.errorCount).to.equal(0);
    });

    it("should set working directory to workspace path", () => {
      const workspacePath = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(workspacePath, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          ...defaultRunConfiguration,
          workspaceFolderPath: workspacePath,
        }
      );

      expect(result.lintResult.errorCount).to.equal(1);
      expect(result.lintResult.warningCount).to.equal(0);
      expect(result.workspaceFolderPath).to.equal(workspacePath);
    });

    it.skip("should return warnings for invalid eslint install", () => {
      const root = path.join(testDataRoot, "invalid-install");
      const filePath = path.join(root, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          ...defaultRunConfiguration,
          workspaceFolderPath: root,
        }
      );

      expect(result.warnings.length).to.equal(1);
    });

    it("should not return errors in js file by default", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "test.js");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.errorCount).to.equal(0);
    });

    it("should return errors in js file if jsEnable is set", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "test.js");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        { ...defaultRunConfiguration, jsEnable: true }
      );

      expect(result.lintResult.errorCount).to.equal(1);
    });

    it("should not return errors in excluded file", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "excluded.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.errorCount).to.equal(0);
    });

    it("should generate warning for invalid node path", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          ...defaultRunConfiguration,
          nodePath: "invalid",
        }
      );

      expect(result.lintResult.errorCount).to.equal(1);
      expect(result.warnings.length).to.equal(1);
    });

    it("should ignore no-unused-varaible rule", () => {
      const root = path.join(testDataRoot, "with-eslint");
      const filePath = path.join(root, "unused-variable.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.errorCount).to.equal(0);
      expect(result.warnings.length).to.equal(0);
    });

    it("should not return errors in js files by default", () => {
      const root = path.join(testDataRoot, "js-disabled");
      {
        const filePath = path.join(root, "test.mjs");
        const result = createEsLintRunner().runEsLint(
          filePath,
          fs.readFileSync(filePath).toString(),
          defaultRunConfiguration
        );
        expect(result.lintResult.errorCount).to.equal(0);
      }
      {
        const filePath = path.join(root, "test.mjs");
        const result = createEsLintRunner().runEsLint(
          filePath,
          fs.readFileSync(filePath).toString(),
          defaultRunConfiguration
        );
        expect(result.lintResult.errorCount).to.equal(0);
      }
    });

    it("should support using a eslint.js config file", () => {
      const root = path.join(testDataRoot, "with-eslint-js-config-file");

      const filePath = path.join(root, "test.ts");
      const result = createEsLintRunner().runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        {
          configFile: path.join(root, "eslint.js"),
          ...defaultRunConfiguration,
        }
      );
      expect(result.lintResult.errorCount).to.equal(2);
      expect(result.lintResult.results[0].messages[0].ruleId).to.equal(
        "array-type"
      );
      expect(result.lintResult.results[1].messages[0].ruleId).to.equal(
        "quotemark"
      );
    });
  });

  describe("filterProblemsForFile", () => {
    it("should filter out all problems not in file", () => {
      const runner = createEsLintRunner();
      const filePath = path.join(testDataRoot, "with-eslint", "test.ts");
      const result = runner.runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.results.length).to.equal(1);

      const filteredFailures = filterProblemsForFile(
        "does-not-exist",
        result.lintResult
      );
      expect(filteredFailures.length).to.equal(0);
    });
  });

  describe("getNonOverlappingReplacements", () => {
    it("should filter out overlapping replacements", () => {
      const runner = createEsLintRunner();
      const filePath = path.join(testDataRoot, "overlapping-errors", "test.ts");
      const result = runner.runEsLint(
        filePath,
        fs.readFileSync(filePath).toString(),
        defaultRunConfiguration
      );

      expect(result.lintResult.results.length).to.equal(2);

      const noOverlappingReplacements = getNonOverlappingReplacements(
        result.lintResult.results.reduce<eslint.Linter.LintMessage[]>(
          (r, m) => [...r, ...m.messages],
          []
        )
      );
      expect(noOverlappingReplacements.length).to.equal(1);
    });
  });
});

function createEsLintRunner() {
  return new EsLintRunner((_value: string) => {
    /* noop */
  });
}
