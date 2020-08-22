import * as eslint from 'eslint' // this is a dev dependency only
import { normalize } from 'path'

/**
 * Filter failures for the given document
 */
export function filterProblemsForFile(
  filePath: string,
  report: eslint.CLIEngine.LintReport
): eslint.Linter.LintMessage[] {
  const normalizedPath = normalize(filePath);
  // we only show diagnostics targetting this open document, some eslint rule return diagnostics for other documents/files
  const normalizedFiles = new Map<string, string>();

  let messages: eslint.Linter.LintMessage[] = [];
  for (const result of report.results) {
    const fileName = result.filePath;
    if (!fileName) {
      continue;
    }

    if (!normalizedFiles.has(fileName)) {
      normalizedFiles.set(fileName, normalize(fileName));
    }
    if (normalizedFiles.get(fileName) === normalizedPath) {
      messages = messages.concat(result.messages);
    }
  }
  return messages;
}

/**
 *
 */
export function getReplacements(
  fix: eslint.Rule.Fix | undefined
): eslint.Rule.Fix[] {
  if (!fix) {
    return [];
  } else if (Array.isArray(fix)) {
    return fix;
  } else {
    return [fix];
  }
}

/**
 *
 */
function getReplacement(
  failure: eslint.Linter.LintMessage,
  at: number
): eslint.Rule.Fix {
  return getReplacements(failure.fix)[at];
}

/**
 *
 */
export function sortFailures(
  failures: eslint.Linter.LintMessage[]
): eslint.Linter.LintMessage[] {
  // The failures.replacements are sorted by position, we sort on the position of the first replacement
  return failures.sort((a, b) => {
    return getReplacement(a, 0).range[0] - getReplacement(b, 0).range[0];
  });
}

/**
 *
 */
export function getNonOverlappingReplacements(
  failures: eslint.Linter.LintMessage[]
): eslint.Rule.Fix[] {
  /**
   *
   */
  function overlaps(a: eslint.Rule.Fix, b: eslint.Rule.Fix): boolean {
    return a.range[1] >= b.range[0];
  }

  const sortedFailures = sortFailures(failures);
  const nonOverlapping: eslint.Rule.Fix[] = [];

  for (let i = 0; i < sortedFailures.length; i++) {
    const replacements = getReplacements(sortedFailures[i].fix);

    if (
      i === 0 ||
      !overlaps(nonOverlapping[nonOverlapping.length - 1], replacements[0])
    ) {
      nonOverlapping.push(...replacements);
    }
  }
  return nonOverlapping;
}
