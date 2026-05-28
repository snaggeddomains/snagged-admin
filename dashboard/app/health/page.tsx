// Source health page. Reads state JSON from the repo via the GitHub Contents API.
// Server component — fetches on each request, no client JS needed.

async function fetchSourceStatus(): Promise<unknown[]> {
  // TODO: real implementation. For now return an empty list so the page renders.
  // const owner = "snaggeddomains";
  // const repo  = "snagged-admin";
  // const path  = "state";
  // const url   = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  // ... walk subdirectories, fetch run_status.json files
  return [];
}

export const revalidate = 60; // re-fetch at most once a minute

export default async function Health() {
  const sources = await fetchSourceStatus();
  return (
    <main style={{ padding: "2rem", maxWidth: 960 }}>
      <h1>Source health</h1>
      {sources.length === 0 ? (
        <p style={{ color: "#666" }}>
          No source state recorded yet. State will appear here once the pipeline has run.
        </p>
      ) : (
        <pre>{JSON.stringify(sources, null, 2)}</pre>
      )}
    </main>
  );
}
