import { describe, expect, it } from 'vitest';
import { parseRef, prMatchesBranch } from '../src/refs.js';

describe('parseRef', () => {
  it('parses a GitHub PR', () => {
    expect(parseRef('https://github.com/acme/api/pull/8821')).toEqual({
      kind: 'github_pr',
      externalId: 'acme/api#8821',
      url: 'https://github.com/acme/api/pull/8821',
      label: 'api#8821',
    });
  });

  it('distinguishes issues from PRs', () => {
    expect(parseRef('https://github.com/acme/api/issues/12')?.kind).toBe('github_issue');
    expect(parseRef('https://github.com/acme/api/issues/12')?.externalId).toBe('acme/api!12');
  });

  it('ignores trailing fragments so the same PR collides', () => {
    const a = parseRef('https://github.com/acme/api/pull/8821');
    const b = parseRef('https://github.com/acme/api/pull/8821#discussion_r123');
    expect(a?.externalId).toBe(b?.externalId);
  });

  it('parses a Slack permalink down to the message', () => {
    const r = parseRef('https://acme.slack.com/archives/C04ABC/p1712345678901234');
    expect(r?.kind).toBe('slack_message');
    expect(r?.externalId).toBe('acme/C04ABC/1712345678901234');
  });

  it('parses Jira from a URL and from a bare key', () => {
    expect(parseRef('https://acme.atlassian.net/browse/PAY-4412')?.externalId).toBe('PAY-4412');
    expect(parseRef('PAY-4412')).toMatchObject({ kind: 'jira_issue', externalId: 'PAY-4412' });
  });

  it('treats paths as files and other links as urls', () => {
    expect(parseRef('/home/dev/src/api/retry.ts')?.kind).toBe('file');
    expect(parseRef('~/notes.md')?.kind).toBe('file');
    expect(parseRef('https://example.com/x')).toMatchObject({ kind: 'url', label: 'example.com' });
  });

  it('returns null for prose', () => {
    expect(parseRef('just some words')).toBeNull();
    expect(parseRef('   ')).toBeNull();
  });
});

describe('prMatchesBranch', () => {
  it('joins a PR to a session on the same branch', () => {
    expect(prMatchesBranch('fix/retry-storm', 'fix/retry-storm')).toBe(true);
  });

  it('never joins on an empty or missing branch', () => {
    // Otherwise every detached-HEAD session would bind to every branchless PR.
    expect(prMatchesBranch('', '')).toBe(false);
    expect(prMatchesBranch(null, 'main')).toBe(false);
    expect(prMatchesBranch('main', null)).toBe(false);
  });
});
