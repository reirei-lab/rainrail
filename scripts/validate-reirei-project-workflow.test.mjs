import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/add-issues-to-reirei-project.yml', import.meta.url),
  'utf8',
);

describe('add issue to Reirei project workflow', () => {
  it('runs only when a new issue is opened', () => {
    expect(workflow).toMatch(/^on:\n {2}issues:\n {4}types:\n {6}- opened/m);
    expect(workflow).not.toContain('pull_request');
    expect(workflow).not.toContain('pull_request_target');
  });

  it('uses a GitHub-hosted runner for issue intake', () => {
    expect(workflow).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(workflow).not.toContain('runs-on: self-hosted');
  });

  it('runs issue automation only for trusted issue authors', () => {
    expect(workflow).toContain('github.event.issue.author_association');
    expect(workflow).toContain("contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.issue.author_association)");
  });

  it('adds the opened issue to the Reirei organization project', () => {
    expect(workflow).toContain('uses: actions/add-to-project@v2.0.0');
    expect(workflow).toContain('project-url: https://github.com/orgs/reirei-lab/projects/1');
    expect(workflow).toContain('github-token: ${{ secrets.REIREI_PROJECT_TOKEN }}');
  });

  it('assigns opened issues to reirei-agent', () => {
    expect(workflow).toMatch(/^ {2}issues: write$/m);
    expect(workflow).toContain('uses: actions/github-script@v9');
    expect(workflow).toContain("assignees: ['reirei-agent']");
    expect(workflow).not.toContain('gh issue edit');
  });
});
