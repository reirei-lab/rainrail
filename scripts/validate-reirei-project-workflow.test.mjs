import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  new URL('../.github/workflows/add-issues-to-reirei-project.yml', import.meta.url),
  'utf8',
);

const trustedAuthorGuard = "if: ${{ steps.check-trusted-author.outputs.trusted == 'true' }}";

/**
 * @param {string} name
 */
function workflowStepBlock(name) {
  const stepStart = workflow.indexOf(`      - name: ${name}`);
  if (stepStart === -1) {
    throw new Error(`Workflow step not found: ${name}`);
  }

  const nextStepStart = workflow.indexOf('\n      - name:', stepStart + 1);
  return workflow.slice(stepStart, nextStepStart === -1 ? undefined : nextStepStart);
}

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

  it('does not skip the job based on the issue event payload author association', () => {
    expect(workflow).not.toContain('github.event.issue.author_association');
    expect(workflow).not.toMatch(/^ {4}if:/m);
  });

  it('loads the opened issue over REST before trusting its author association', () => {
    expect(workflow).toContain('id: check-trusted-author');
    expect(workflow).toContain('const { data: issue } = await github.rest.issues.get({');
    expect(workflow).toContain('issue_number: context.issue.number');
    expect(workflow).toContain("const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);");
    expect(workflow).toContain("const trustedPermissions = new Set(['admin', 'maintain', 'write']);");
    expect(workflow).toContain("const trustedRoles = new Set(['admin', 'maintain', 'write', 'triage']);");
    expect(workflow).toContain('github.rest.repos.getCollaboratorPermissionLevel({');
    expect(workflow).toContain('username: issue.user.login');
    expect(workflow).toContain('trustedPermissions.has(data.permission)');
    expect(workflow).toContain('trustedRoles.has(data.role_name)');
    expect(workflow).toContain("core.setOutput('trusted', String(trusted));");
  });

  it('gates project and assignment side effects on trusted REST issue authors', () => {
    expect(workflowStepBlock('Assign issue to reirei-agent')).toContain(trustedAuthorGuard);
    expect(workflowStepBlock('Add issue to Reirei project')).toContain(trustedAuthorGuard);
    expect(workflow).not.toContain("if: ${{ contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'),");
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
