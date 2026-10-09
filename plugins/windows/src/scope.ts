import type { PermissionMatcher } from "@bunaway/plugin";

/** Reject malformed scopes and match control access only when the view IDs agree. */
export const matches: PermissionMatcher = (_permission, input, scope) => {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope)
  ) {
    return false;
  }
  return input.view === scope.view;
};
