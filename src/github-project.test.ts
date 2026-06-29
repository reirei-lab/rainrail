import { describe, expect, it, vi } from 'vitest';

import { createGitHubProjectTaskQueueProvider, type GitHubProjectTaskQueueConfig } from './github-project.js';

describe('createGitHubProjectTaskQueueProvider', () => {
  it('loads all GitHub Project pages and maps issue fields into task queue issues', async () => {
    const requests: Array<{ variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { variables?: Record<string, unknown> };
        requests.push(request);
        if (request.variables?.after === 'cursor_page_2') {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      projectItem({
                        id: 'item_2',
                        contentId: 'issue_node_2',
                        number: 2,
                        title: 'Second page',
                        status: 'Todo',
                        assignees: ['reirei-agent'],
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            organization: {
              projectV2: {
                items: {
                  nodes: [
                    projectItem({
                      id: 'item_1',
                      contentId: 'issue_node_1',
                      number: 1,
                      title: 'First page',
                      status: 'Done',
                      assignees: ['reirei-agent'],
                    }),
                    { id: 'item_pr', content: { __typename: 'PullRequest' }, fieldValues: { nodes: [] } },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: 'cursor_page_2' },
                },
              },
            },
          },
        });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_1', contentId: 'issue_node_1', status: 'Done', number: 1 },
      { id: 'item_2', contentId: 'issue_node_2', status: 'Todo', number: 2 },
    ]);
    expect(requests.map((request) => request.variables?.after)).toEqual([undefined, 'cursor_page_2']);
    expect(requests[0]?.variables).toMatchObject({ organization: 'reirei-lab', projectNumber: 1 });
  });

  it('claims a project issue with status, agent session, branch fields, and an issue comment', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
      calls.push(request);
      if (request.query?.includes('RainrailProjectMetadata')) {
        return jsonResponse({
          data: {
            organization: {
              projectV2: {
                id: 'PVT_project',
                fields: {
                  nodes: [
                    {
                      __typename: 'ProjectV2SingleSelectField',
                      id: 'PVTSSF_status',
                      name: 'Status',
                      options: [{ id: 'status_in_progress', name: 'In Progress' }],
                    },
                    { __typename: 'ProjectV2Field', id: 'PVTF_session', name: 'Agent session ID', dataType: 'TEXT' },
                    { __typename: 'ProjectV2Field', id: 'PVTF_branch', name: 'Branch', dataType: 'TEXT' },
                  ],
                },
              },
            },
          },
        });
      }
      if (request.query?.includes('addComment')) {
        return jsonResponse({
          data: { addComment: { commentEdge: { node: { id: 'comment_1', url: 'https://github.com/reirei-lab/rainrail/issues/21#issuecomment-1' } } } },
        });
      }
      return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
    });
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 21,
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    })).resolves.toMatchObject({
      projectId: 'PVT_project',
      projectItemId: 'item_21',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'status_in_progress',
      agentSessionIdFieldId: 'PVTF_session',
      branchFieldId: 'PVTF_branch',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/21#issuecomment-1',
    });
    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(3);
    expect(calls.find((call) => call.query?.includes('addComment'))?.variables).toMatchObject({
      subjectId: 'issue_node_21',
      body: 'started',
    });
  });

  it('loads paginated Project field metadata before claiming an issue', async () => {
    const metadataRequests: Array<Record<string, unknown> | undefined> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        if (request.query?.includes('RainrailProjectMetadata')) {
          metadataRequests.push(request.variables);
          if (request.variables?.fieldsAfter === undefined) {
            return jsonResponse({
              data: {
                organization: {
                  projectV2: {
                    id: 'PVT_project',
                    fields: {
                      nodes: [{ __typename: 'ProjectV2Field', id: 'PVTF_other', name: 'Other', dataType: 'TEXT' }],
                      pageInfo: { hasNextPage: true, endCursor: 'fields_page_2' },
                    },
                  },
                },
              },
            });
          }
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  id: 'PVT_project',
                  fields: {
                    nodes: [
                      {
                        __typename: 'ProjectV2SingleSelectField',
                        id: 'PVTSSF_status',
                        name: 'Status',
                        options: [{ id: 'status_in_progress', name: 'In Progress' }],
                      },
                      { __typename: 'ProjectV2Field', id: 'PVTF_session', name: 'Agent session ID', dataType: 'TEXT' },
                      { __typename: 'ProjectV2Field', id: 'PVTF_branch', name: 'Branch', dataType: 'TEXT' },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('addComment')) {
          return jsonResponse({ data: { addComment: { commentEdge: { node: { id: 'comment_1' } } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.claimProjectIssue({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    });

    expect(metadataRequests.map((variables) => variables?.fieldsAfter)).toEqual([undefined, 'fields_page_2']);
  });
});

function projectConfig(overrides: Partial<GitHubProjectTaskQueueConfig> = {}): GitHubProjectTaskQueueConfig {
  return {
    organization: 'reirei-lab',
    projectNumber: 1,
    assigneeLogin: 'reirei-agent',
    todoStatus: 'Todo',
    backlogStatus: 'Backlog',
    inProgressStatus: 'In Progress',
    statusFieldName: 'Status',
    agentSessionIdFieldName: 'Agent session ID',
    branchFieldName: 'Branch',
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function projectItem(input: {
  id: string;
  contentId: string;
  number: number;
  title: string;
  status: string;
  assignees: string[];
}): unknown {
  return {
    id: input.id,
    content: {
      __typename: 'Issue',
      id: input.contentId,
      title: input.title,
      state: 'OPEN',
      number: input.number,
      url: `https://github.com/reirei-lab/rainrail/issues/${input.number}`,
      repository: { nameWithOwner: 'reirei-lab/rainrail' },
      assignees: { nodes: input.assignees.map((login) => ({ login })) },
    },
    fieldValues: {
      nodes: [
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: input.status },
      ],
    },
  };
}
