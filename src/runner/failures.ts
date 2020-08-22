import * as eslint from 'eslint' // this is a dev dependency only
import { normalize } from 'path'

/**
 * Filter failures for the given document
 */
export function filterProblemsForFile(
  filePath: string,
  failures: eslint.Linter.LintMessage[]
): eslint.Linter.LintMessage[] {
  const normalizedPath = normalize(filePath);
  // we only show diagnostics targetting this open document, some eslint rule return diagnostics for other documents/files
  const normalizedFiles = new Map<string, string>();
  return failures.filter((each) => {
    const fileName = each.source;
    if (!fileName) {
      return;
    }

    if (!normalizedFiles.has(fileName)) {
      normalizedFiles.set(fileName, normalize(fileName));
    }
    return normalizedFiles.get(fileName) === normalizedPath;
  });
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
