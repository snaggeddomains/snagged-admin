// Per-user Slack DM (so a deal notification can reach someone privately, honoring their
// pref). Resolves the Slack user by email then posts a DM. Best-effort: needs the bot
// scopes users:read.email + chat:write (+ im:write); missing scope / no match → no-op.

export async function slackDm(email: string, text: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !email) return false;
  try {
    const lu = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ ok?: boolean; user?: { id?: string } }>);
    const uid = lu?.user?.id;
    if (!uid) return false;
    const post = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: uid, text }),
    }).then((r) => r.json() as Promise<{ ok?: boolean }>);
    return !!post?.ok;
  } catch {
    return false;
  }
}
