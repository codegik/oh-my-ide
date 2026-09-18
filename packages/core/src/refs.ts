import type { RefKind } from './types.js';

export interface ParsedRef {
  kind: RefKind;
  /** Canonical, stable identity. Two pastes of the same thing must collide here. */
  externalId: string;
  url: string | null;
  label: string;
}

/**
 * Paste-a-link, get a typed ref. Pure regex, no API calls — this is 80% of the
 * linking value on day one, and it works offline and without any auth.
 */
export function parseRef(input: string): ParsedRef | null {
  const text = input.trim();
  if (!text) return null;

  const gh = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/i.exec(
    text,
  );
  if (gh) {
    const [, owner, repo, type, num] = gh;
    const isPr = type?.toLowerCase() === 'pull';
    return {
      kind: isPr ? 'github_pr' : 'github_issue',
      externalId: `${owner}/${repo}${isPr ? '#' : '!'}${num}`,
      url: text,
      label: `${repo}${isPr ? '#' : '!'}${num}`,
    };
  }

  // Slack permalinks: /archives/<channel>/p<ts>. The ts is the message identity.
  const slack = /^https?:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/i.exec(text);
  if (slack) {
    const [, workspace, channel, ts] = slack;
    return {
      kind: 'slack_message',
      externalId: `${workspace}/${channel}/${ts}`,
      url: text,
      label: `slack ${channel}`,
    };
  }

  const jiraUrl = /^https?:\/\/([\w-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/i.exec(text);
  if (jiraUrl) {
    const key = (jiraUrl[2] ?? '').toUpperCase();
    return { kind: 'jira_issue', externalId: key, url: text, label: key };
  }

  // A bare ticket key typed by hand, e.g. "PAY-4412".
  const bareJira = /^([A-Z][A-Z0-9]{1,9}-\d+)$/.exec(text);
  if (bareJira) {
    const key = bareJira[1] as string;
    return { kind: 'jira_issue', externalId: key, url: null, label: key };
  }

  if (/^[~/.]/.test(text) && !text.includes(' ')) {
    return { kind: 'file', externalId: text, url: null, label: text.split('/').pop() || text };
  }

  if (/^https?:\/\//i.test(text)) {
    let label = text;
    try {
      label = new URL(text).hostname.replace(/^www\./, '');
    } catch {
      // Keep the raw text as the label if it will not parse as a URL.
    }
    return { kind: 'url', externalId: text, url: text, label };
  }

  return null;
}

/** A PR's head branch is the join key to a Claude session's branch. */
export function prMatchesBranch(
  prHeadBranch: string | null,
  sessionBranch: string | null,
): boolean {
  return (
    prHeadBranch !== null &&
    sessionBranch !== null &&
    prHeadBranch.length > 0 &&
    prHeadBranch === sessionBranch
  );
}
