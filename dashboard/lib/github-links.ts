// Helpers for building deep links into the GitHub web UI for read/edit
// actions on specific files. Used by the dashboard's "Edit on GitHub →"
// buttons (V2 architecture: read-only dashboard, edits happen in GitHub).

const OWNER = "snaggeddomains";
const REPO = "snagged-admin";
const BRANCH = "main";
const BASE = `https://github.com/${OWNER}/${REPO}`;

/** Edit a file in GitHub's online editor (creates a new commit on save). */
export function editFile(path: string, line?: number): string {
  const suffix = line ? `#L${line}` : "";
  return `${BASE}/edit/${BRANCH}/${path}${suffix}`;
}

/** View a file. */
export function viewFile(path: string, line?: number): string {
  const suffix = line ? `#L${line}` : "";
  return `${BASE}/blob/${BRANCH}/${path}${suffix}`;
}

/** View a directory tree. */
export function viewDir(path: string): string {
  return `${BASE}/tree/${BRANCH}/${path}`;
}

/** Convert a source_id (underscores) to a workflow filename slug (hyphens),
 * matching the convention used in .github/workflows/source-<slug>.yml. */
export function workflowPathFor(sourceId: string): string {
  return `.github/workflows/source-${sourceId.replace(/_/g, "-")}.yml`;
}

/** Source module path for a given source_id. */
export function sourceModulePathFor(sourceId: string): string {
  return `src/marketplace_pipeline/sources/${sourceId}.py`;
}

/** Run-workflow page (you can manually trigger a workflow_dispatch from here). */
export function runWorkflowPage(sourceId: string): string {
  return `${BASE}/actions/workflows/source-${sourceId.replace(/_/g, "-")}.yml`;
}
