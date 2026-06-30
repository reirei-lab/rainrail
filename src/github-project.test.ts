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

  it('fails when the configured Project cannot be loaded', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async () => jsonResponse({ data: { organization: { projectV2: null } } })) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).rejects.toThrow('GitHub Project items response is missing project items');
  });

  it('claims a project issue with a starting lock before updating Project fields', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
      calls.push(request);
      if (isCreateLockCommitRequest(_url)) {
        return lockCommitResponse();
      }
      if (request.query?.includes('RainrailProjectItemStatus')) {
        return jsonResponse({
          data: {
            node: projectItem({
              id: 'item_21',
              contentId: 'issue_node_21',
              number: 21,
              title: 'Project issue selection',
              status: calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length === 0
                ? 'Todo'
                : 'In Progress',
              assignees: ['reirei-agent'],
              agentSessionId: calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length === 0
                ? ''
                : 'agent:main:rainrail-21',
              branchName: calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length === 0
                ? ''
                : 'agent/reirei-lab-rainrail-21-project-issue-selection',
            }),
          },
        });
      }
      if (request.query?.includes('RainrailProjectMetadata')) {
        return projectMetadataResponse();
      }
      if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
        return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
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
      contentId: 'issue_node_21',
      commentBody: 'started',
      lockRefId: 'REF_lock',
    });
    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.filter((call) => call.query?.includes('RainrailProjectItemStatus'))).toHaveLength(2);
    expect(calls.find((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))?.variables).toMatchObject({
      repositoryId: 'R_repo',
      name: 'refs/heads/rainrail/locks/reirei-lab-rainrail-21-item-21',
      oid: 'lock_sha',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/reirei-lab/rainrail/git/commits',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Rainrail project issue claim lock'),
      }),
    );
    expect(calls.find((call) => call.query?.includes('addComment'))).toBeUndefined();
  });

  it('finalizes a starting claim after dispatch starts durably', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: updateCount === 0 ? 'Todo' : 'In Progress',
                agentSessionId: updateCount < 2 ? '' : 'agent:main:rainrail-21',
                branchName: updateCount < 3 ? '' : 'agent/reirei-lab-rainrail-21-project-issue-selection',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        if (request.query?.includes('addComment')) {
          return jsonResponse({
            data: { addComment: { commentEdge: { node: { id: 'comment_1', url: 'https://github.com/reirei-lab/rainrail/issues/21#issuecomment-1' } } } },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    const issue = {
      id: 'item_21',
      contentId: 'issue_node_21',
      contentType: 'Issue' as const,
      title: 'Project issue selection',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
    };
    const claim = await provider.claimProjectIssue({
      issue,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    });

    await provider.finalizeProjectIssueClaim?.({
      issue,
      claim,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    });

    const updateValues = calls
      .filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))
      .map((call) => JSON.stringify(call.variables?.value));
    expect(updateValues).toEqual([
      '{"singleSelectOptionId":"status_in_progress"}',
      '{"text":"agent:main:rainrail-21"}',
      '{"text":"agent/reirei-lab-rainrail-21-project-issue-selection"}',
    ]);
    expect(calls.find((call) => call.query?.includes('addComment'))?.variables).toMatchObject({
      subjectId: 'issue_node_21',
      body: 'started',
    });
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('does not update Project fields while acquiring a starting claim', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).resolves.toMatchObject({ lockRefId: 'REF_lock' });

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
  });

  it('does not roll back Project fields when claim fails before updating status', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const statusReadCount = calls.filter((call) => call.query?.includes('RainrailProjectItemStatus')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: statusReadCount === 1 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('does not move backlog child issues to in progress before dispatch starts', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_22',
                contentId: 'issue_node_22',
                number: 22,
                title: 'Child issue',
                status: updateCount === 0 ? 'Backlog' : 'In Progress',
                assignees: [],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (
          request.query?.includes('updateProjectV2ItemFieldValue')
          && JSON.stringify(request.variables?.value).includes('agent:main:rainrail-22')
        ) {
          return new Response(JSON.stringify({ errors: [{ message: 'field update failed' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_22' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        status: 'Backlog',
        assigneeLogins: [],
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
      commentBody: 'started',
    })).resolves.toMatchObject({ projectItemId: 'item_22', lockRefId: 'REF_lock' });

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
  });

  it('allows claiming a selected backlog child issue', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: claimSuccessFetch({
        beforeStatus: 'Backlog',
        beforeAssignees: [],
        afterAgentSessionId: 'agent:main:rainrail-22',
        afterBranchName: 'agent/reirei-lab-rainrail-22-child-issue',
      }),
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        status: 'Backlog',
        assigneeLogins: [],
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
      commentBody: 'started',
    })).resolves.toMatchObject({
      projectItemId: 'item_22',
      statusOptionId: 'status_in_progress',
    });
  });

  it('reads fixed Project item status aliases when configured field names are custom', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig({
        statusFieldName: 'Queue Status',
        branchFieldName: 'Agent Branch',
      }),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: claimSuccessFetch({
        metadata: projectMetadataResponse({
          statusFieldName: 'Queue Status',
          branchFieldName: 'Agent Branch',
        }),
      }),
    });

    await expect(provider.claimProjectIssue({
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
    })).resolves.toMatchObject({ projectItemId: 'item_21' });
  });

  it('rejects claims when the issue was reassigned before claim confirmation', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: claimSuccessFetch({
        beforeAssignees: ['other-agent'],
      }),
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('GitHub Project item is no longer assigned to this agent');
  });

  it('rejects stale claims when the item is no longer todo or already has an agent session', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string };
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: 'agent:main:other',
              }),
            },
          });
        }
        return jsonResponse({ data: { organization: { projectV2: { id: 'PVT_project', fields: { nodes: [] } } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('GitHub Project item is no longer claimable');
  });

  it('rejects concurrent claims before updating Project fields when the issue lock exists', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const statusReadCount = calls.filter((call) => call.query?.includes('RainrailProjectItemStatus')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: statusReadCount === 1 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: statusReadCount === 1 ? '' : 'agent:main:other-runner',
                branchName: statusReadCount === 1 ? '' : 'agent/reirei-lab-rainrail-21-other-runner',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLock')) {
          return lockRefResponse({ createdAt: new Date().toISOString() });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('Reference already exists');

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
  });

  it('does not delete an existing issue lock while a concurrent claim may still be active', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: updateCount === 0 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: updateCount < 2 ? '' : 'agent:main:rainrail-21',
                branchName: updateCount < 3 ? '' : 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLock')) {
          return lockRefResponse({ createdAt: new Date().toISOString() });
        }
        if (request.query?.includes('addComment')) {
          return jsonResponse({ data: { addComment: { commentEdge: { node: { id: 'comment_1' } } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('Reference already exists');

    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(1);
    expect(calls.find((call) => call.query?.includes('RainrailProjectIssueClaimLock'))).toBeDefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
  });

  it('recovers an expired issue lock when the Project item is still unclaimed', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createLockAttempts = 0;
    let commitAttempts = 0;
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          commitAttempts += 1;
          return lockCommitResponse(`lock_sha_${commitAttempts}`);
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: updateCount === 0 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: updateCount < 2 ? '' : 'agent:main:rainrail-21',
                branchName: updateCount < 3 ? '' : 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          createLockAttempts += 1;
          if (createLockAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLock')) {
          return lockRefResponse({ id: 'REF_lock_expired', createdAt: '2000-01-01T00:00:00.000Z' });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        if (request.query?.includes('addComment')) {
          return jsonResponse({ data: { addComment: { commentEdge: { node: { id: 'comment_1' } } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).resolves.toMatchObject({ lockRefId: 'REF_lock_new' });

    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(2);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock_expired',
    });
    expect(calls
      .filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))
      .map((call) => call.variables?.oid)).toEqual(['lock_sha_1', 'lock_sha_2']);
  });

  it('releases a claimed issue back to todo status', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21' },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    });

    const updateValues = calls
      .filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))
      .map((call) => JSON.stringify(call.variables?.value));
    expect(updateValues).toEqual([
      '{"text":""}',
      '{"text":""}',
      '{"singleSelectOptionId":"status_todo"}',
    ]);
  });

  it('does not clear Project fields when release sees a different current claim', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: 'agent:main:other-runner',
                branchName: 'agent/reirei-lab-rainrail-21-other-runner',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
      }) as typeof fetch,
    });

    await provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21', lockRefId: 'REF_lock' },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    });

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('does not release a matching claim after the Project status moved out of in progress', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Done',
                assignees: ['reirei-agent'],
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21', lockRefId: 'REF_lock' },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    });

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('does not roll back status-only Project changes for an unfinalized starting claim', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: '',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21', lockRefId: 'REF_lock' },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    });

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('recovers stale status-only partial claims while listing Project issues', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectIssues')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      projectItem({
                        id: 'item_21',
                        contentId: 'issue_node_21',
                        number: 21,
                        title: 'Project issue selection',
                        status: 'In Progress',
                        assignees: ['reirei-agent'],
                        agentSessionId: '',
                        branchName: '',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: '',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLock')) {
          return lockRefResponse({
            id: 'REF_lock_expired',
            createdAt: '2000-01-01T00:00:00.000Z',
            originalStatus: 'Todo',
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'Todo' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_todo')
    )).toBeDefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock_expired',
    });
  });

  it('does not recover a dispatched starting lock after finalize fails', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse(`lock_sha_${calls.length}`);
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_lock' } } } });
        }
        if (
          request.query?.includes('updateProjectV2ItemFieldValue')
          && JSON.stringify(request.variables?.value).includes('status_in_progress')
        ) {
          return new Response(JSON.stringify({ errors: [{ message: 'field update failed' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    const issue = {
      id: 'item_21',
      contentId: 'issue_node_21',
      contentType: 'Issue' as const,
      title: 'Project issue selection',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
    };
    const claim = await provider.claimProjectIssue({
      issue,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue,
      claim,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).rejects.toThrow('field update failed');

    expect(calls.find((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock'))).toBeDefined();
    expect(calls.some((call) => JSON.stringify(call).includes('dispatchedAt'))).toBe(true);
  });

  it('does not delete expired locks that already dispatched an agent', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLock')) {
          return lockRefResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
          });
        }
        return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
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
    })).rejects.toThrow('Reference already exists');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('uses fieldValueByName and open blocker totals for queue-critical fields', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async () => jsonResponse({
        data: {
          organization: {
            projectV2: {
              items: {
                nodes: [
                  projectItem({
                    id: 'item_21',
                    contentId: 'issue_node_21',
                    number: 21,
                    title: 'Project issue selection',
                    status: 'Todo',
                    assignees: ['reirei-agent'],
                    blockedByOpenTotal: 1,
                  }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      {
        id: 'item_21',
        status: 'Todo',
        blockedBy: [{ state: 'OPEN' }],
      },
    ]);
  });

  it('uses the fixed status alias when listing custom status fields', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig({ statusFieldName: 'Queue Status' }),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async () => jsonResponse({
        data: {
          organization: {
            projectV2: {
              items: {
                nodes: [
                  {
                    ...projectItem({
                      id: 'item_21',
                      contentId: 'issue_node_21',
                      number: 21,
                      title: 'Project issue selection',
                      status: 'Todo',
                      assignees: ['reirei-agent'],
                    }) as Record<string, unknown>,
                    fieldValues: { nodes: [] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      })) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'Todo' },
    ]);
  });

  it('does not release a claim after another runner overwrites it', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: updateCount === 0 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: updateCount === 0 ? '' : 'agent:main:other-runner',
                branchName: updateCount === 0 ? '' : 'agent/reirei-lab-rainrail-21-other-runner',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    const issue = {
      id: 'item_21',
      contentId: 'issue_node_21',
      contentType: 'Issue' as const,
      title: 'Project issue selection',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
    };
    const claim = await provider.claimProjectIssue({
      issue,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue,
      claim,
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).rejects.toThrow('GitHub Project item claim was overwritten by another assignment');

    expect(calls.filter((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_todo')
    )).toHaveLength(0);
  });

  it('loads paginated Project field metadata before claiming an issue', async () => {
    const metadataRequests: Array<Record<string, unknown> | undefined> = [];
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updateCount = calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).length;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: updateCount === 0 ? 'Todo' : 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: updateCount < 2 ? '' : 'agent:main:rainrail-21',
                branchName: updateCount < 3 ? '' : 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
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
                        options: [
                          { id: 'status_todo', name: 'Todo' },
                          { id: 'status_backlog', name: 'Backlog' },
                          { id: 'status_in_progress', name: 'In Progress' },
                        ],
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
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
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

function isCreateLockCommitRequest(url: string | URL | Request): boolean {
  return String(url).includes('/repos/reirei-lab/rainrail/git/commits');
}

function lockCommitResponse(sha = 'lock_sha'): Response {
  return jsonResponse({ sha });
}

function lockRefResponse(input: {
  id?: string;
  createdAt?: string;
  dispatchedAt?: string;
  agentSessionId?: string;
  branchName?: string;
  projectItemId?: string;
  originalStatus?: string;
} = {}): Response {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return jsonResponse({
    data: {
      node: {
        ref: {
          id: input.id ?? 'REF_lock_existing',
          target: {
            oid: 'lock_sha_existing',
            committedDate: createdAt,
            message: [
              'Rainrail project issue claim lock',
              '',
              JSON.stringify({
                version: 1,
                createdAt,
                agentSessionId: input.agentSessionId ?? 'agent:main:other-runner',
                branchName: input.branchName ?? 'agent/reirei-lab-rainrail-21-other-runner',
                projectItemId: input.projectItemId ?? 'item_21',
                originalStatus: input.originalStatus ?? 'Todo',
                ...(input.dispatchedAt === undefined ? {} : { dispatchedAt: input.dispatchedAt }),
              }),
            ].join('\n'),
          },
        },
      },
    },
  });
}

function projectMetadataResponse(overrides: {
  statusFieldName?: string;
  branchFieldName?: string;
} = {}): Response {
  const statusFieldName = overrides.statusFieldName ?? 'Status';
  const branchFieldName = overrides.branchFieldName ?? 'Branch';
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
                name: statusFieldName,
                options: [
                  { id: 'status_todo', name: 'Todo' },
                  { id: 'status_backlog', name: 'Backlog' },
                  { id: 'status_in_progress', name: 'In Progress' },
                ],
              },
              { __typename: 'ProjectV2Field', id: 'PVTF_session', name: 'Agent session ID', dataType: 'TEXT' },
              { __typename: 'ProjectV2Field', id: 'PVTF_branch', name: branchFieldName, dataType: 'TEXT' },
            ],
          },
        },
      },
    },
  });
}

function claimSuccessFetch(input: {
  beforeStatus?: string;
  beforeAssignees?: string[];
  afterAgentSessionId?: string;
  afterBranchName?: string;
  metadata?: Response;
} = {}): typeof fetch {
  let updateCount = 0;
  return (async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
    if (isCreateLockCommitRequest(_url)) {
      return lockCommitResponse();
    }
    if (request.query?.includes('RainrailProjectItemStatus')) {
      const before = updateCount === 0;
      return jsonResponse({
        data: {
          node: projectItem({
            id: 'item_21',
            contentId: 'issue_node_21',
            number: 21,
            title: 'Project issue selection',
            status: before ? input.beforeStatus ?? 'Todo' : 'In Progress',
            assignees: before ? input.beforeAssignees ?? ['reirei-agent'] : ['reirei-agent'],
            agentSessionId: before ? '' : input.afterAgentSessionId ?? 'agent:main:rainrail-21',
            branchName: before ? '' : input.afterBranchName ?? 'agent/reirei-lab-rainrail-21-project-issue-selection',
          }),
        },
      });
    }
    if (request.query?.includes('RainrailProjectMetadata')) {
      return input.metadata ?? projectMetadataResponse();
    }
    if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
      return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
    }
    if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
      return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
    }
    if (request.query?.includes('addComment')) {
      return jsonResponse({ data: { addComment: { commentEdge: { node: { id: 'comment_1' } } } } });
    }
    updateCount += 1;
    return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
  }) as typeof fetch;
}

function projectItem(input: {
  id: string;
  contentId: string;
  number: number;
  title: string;
  status: string;
  assignees: string[];
  agentSessionId?: string;
  branchName?: string;
  blockedByOpenTotal?: number;
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
      repository: {
        id: 'R_repo',
        nameWithOwner: 'reirei-lab/rainrail',
        defaultBranchRef: { target: { oid: 'base_sha', tree: { oid: 'base_tree' } } },
      },
      assignees: { nodes: input.assignees.map((login) => ({ login })) },
      blockedBy: {
        totalCount: input.blockedByOpenTotal ?? 0,
        nodes: [],
      },
    },
    fieldValues: {
      nodes: [
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: input.status },
        { __typename: 'ProjectV2ItemFieldTextValue', field: { name: 'Agent session ID' }, text: input.agentSessionId ?? '' },
        { __typename: 'ProjectV2ItemFieldTextValue', field: { name: 'Branch' }, text: input.branchName ?? '' },
      ],
    },
    status: { name: input.status },
    agentSessionId: { text: input.agentSessionId ?? '' },
    branch: { text: input.branchName ?? '' },
    branchName: { text: input.branchName ?? '' },
  };
}
