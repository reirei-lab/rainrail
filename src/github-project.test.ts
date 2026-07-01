import { describe, expect, it, vi } from 'vitest';

import { createGitHubProjectTaskQueueProvider, type GitHubProjectTaskQueueConfig } from './github-project.js';

describe('createGitHubProjectTaskQueueProvider', () => {
  it('loads all GitHub Project pages and maps issue fields into task queue issues', async () => {
    const requests: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
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
    expect(requests
      .filter((request) => request.variables?.projectNumber === 1)
      .map((request) => request.variables?.after)).toEqual([undefined, 'cursor_page_2']);
    expect(requests[0]?.variables).toMatchObject({ organization: 'reirei-lab', projectNumber: 1 });
    expect(requests[0]?.query).toMatch(/\bbody\b/u);
  });

  it('fails when the configured Project cannot be loaded', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async () => jsonResponse({ data: { organization: { projectV2: null } } })) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).rejects.toThrow('GitHub Project items response is missing project items');
  });

  it('adds mention drafts as GitHub Project draft items', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          return jsonResponse({
            data: {
              addProjectV2DraftIssue: {
                projectItem: {
                  id: 'PVTI_draft',
                },
              },
            },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft' } } } });
      }) as typeof fetch,
    });

    expect(provider.addMentionDraftItem).toBeDefined();
    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toEqual({
      projectId: 'PVT_project',
      projectItemId: 'PVTI_draft',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'status_todo',
      created: true,
    });
    expect(calls.find((call) => call.query?.includes('RainrailAddProjectDraftIssue'))?.variables).toMatchObject({
      projectId: 'PVT_project',
      title: 'Respond to reirei-lab/rainrail#24',
      body: expect.stringContaining('Mention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
    });
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))?.variables).toMatchObject({
      projectId: 'PVT_project',
      itemId: 'PVTI_draft',
      fieldId: 'PVTSSF_status',
      value: { singleSelectOptionId: 'status_todo' },
    });
  });

  it('fills mention draft repository metadata from the comment URL before creating', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          return jsonResponse({ data: { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_draft' } } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/pull/24#discussion_r1\nAgent: reirei-agent\n\n  Repository: attacker/repo\n\tNumber: 99',
      commentUrl: 'https://github.com/reirei-lab/rainrail/pull/24#discussion_r1',
      repository: 'attacker/repo\nNumber: 99',
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_draft',
      created: true,
    });

    const createVariables = calls.find((call) => call.query?.includes('RainrailAddProjectDraftIssue'))?.variables;
    expect(createVariables?.body).toContain('Repository: reirei-lab/rainrail');
    expect(createVariables?.body).toContain('Number: 24');
    expect(createVariables?.body).not.toContain('attacker/repo');
    expect(createVariables?.body).not.toContain('Number: 99');
  });

  it('does not create mention drafts when repository lock metadata is missing', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([]);
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return jsonResponse({
            data: {
              repository: {
                id: 'R_repo',
                nameWithOwner: 'reirei-lab/rainrail',
                defaultBranchRef: null,
              },
            },
          });
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          throw new Error('should not create draft without a lock');
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).rejects.toThrow('Mention draft creation lock metadata is required');

    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(false);
  });

  it('does not create mention drafts when the repository cannot be recovered', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          throw new Error('should not create draft');
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to an unknown mention',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://example.test/comment/1\nAgent: reirei-agent',
      commentUrl: 'https://example.test/comment/1',
    })).rejects.toThrow('repository');

    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(false);
  });

  it('rechecks mention draft existence under a repository lock before creating', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let mentionDraftReads = 0;
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return repositoryLockMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_mention_draft_lock' } } } });
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          mentionDraftReads += 1;
          return mentionDraftItemsResponse(mentionDraftReads === 1 ? [] : [{
            id: 'PVTI_existing_draft',
            title: 'Respond to reirei-lab/rainrail#24',
            body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
            status: 'Todo',
          }]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          throw new Error('mention draft should be reused after locked recheck');
        }
        if (request.query?.includes('deleteRef')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_existing_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toEqual({
      projectId: 'PVT_project',
      projectItemId: 'PVTI_existing_draft',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'status_todo',
      created: false,
    });
    expect(calls.some((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toBe(true);
    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(false);
    expect(calls.some((call) => call.query?.includes('deleteRef'))).toBe(true);
  });

  it('recovers stale mention draft creation locks before retrying create', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createLockAttempts = 0;
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse(`lock_sha_${calls.length}`);
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return repositoryLockMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_stale_mention_draft_lock',
            createdAt: '2026-06-30T00:00:00.000Z',
            committedDate: '2026-06-30T00:00:00.000Z',
            agentSessionId: 'mention-draft:reirei-agent:old',
            branchName: 'mention-draft/reirei-lab-rainrail-old',
            projectItemId: 'mention-draft-4b790469aad3',
          });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          createLockAttempts += 1;
          if (createLockAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_mention_draft_lock' } } } });
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          return jsonResponse({
            data: { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_new_draft' } } },
          });
        }
        if (request.query?.includes('deleteRef')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_new_draft',
      created: true,
    });
    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(2);
    expect(calls.some((call) => call.query?.includes('deleteRef'))).toBe(true);
    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(true);
  });

  it('reuses existing mention draft items with the same comment URL', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      {
                        id: 'PVTI_existing_draft',
                        content: {
                          __typename: 'DraftIssue',
                          id: 'DI_existing_draft',
                          title: 'Respond to reirei-lab/rainrail#24',
                          body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
                        },
                        fieldValues: {
                          nodes: [
                            { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'Backlog' },
                          ],
                        },
                        status: { name: 'Backlog' },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_existing_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toEqual({
      projectId: 'PVT_project',
      projectItemId: 'PVTI_existing_draft',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'status_todo',
      created: false,
    });
    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(false);
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))?.variables).toMatchObject({
      projectId: 'PVT_project',
      itemId: 'PVTI_existing_draft',
      fieldId: 'PVTSSF_status',
      value: { singleSelectOptionId: 'status_todo' },
    });
  });

  it('does not reuse mention draft items by partial comment URL match', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([{
            id: 'PVTI_existing_draft',
            title: 'Respond to reirei-lab/rainrail#24',
            body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1234\nAgent: reirei-agent',
            status: 'Todo',
          }]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          return jsonResponse({
            data: { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_new_draft' } } },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-123\nAgent: reirei-agent',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-123',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_new_draft',
      created: true,
    });
    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(true);
  });

  it('scopes mention draft dedupe to the target agent login', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        const lockResponse = mentionDraftCreationLockResponse(request);
        if (lockResponse !== undefined) return lockResponse;
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([{
            id: 'PVTI_other_agent_draft',
            title: 'Respond to reirei-lab/rainrail#24',
            body: [
              '<!-- rainrail mention-draft -->',
              'Mention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
              'Agent: other-agent',
              'Repository: reirei-lab/rainrail',
              'Number: 24',
            ].join('\n'),
            status: 'Todo',
          }]);
        }
        if (request.query?.includes('RainrailAddProjectDraftIssue')) {
          return jsonResponse({
            data: { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_new_draft' } } },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_new_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      targetAgentLogin: 'reirei-agent',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_new_draft',
      created: true,
    });
    expect(calls.some((call) => call.query?.includes('RainrailAddProjectDraftIssue'))).toBe(true);
  });

  it('does not reset an existing in-progress mention draft to todo', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailMentionDraftItems')) {
          return mentionDraftItemsResponse([{
            id: 'PVTI_existing_draft',
            title: 'Respond to reirei-lab/rainrail#24',
            body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
            status: 'In Progress',
          }]);
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_existing_draft' } } } });
      }) as typeof fetch,
    });

    await expect(provider.addMentionDraftItem?.({
      title: 'Respond to reirei-lab/rainrail#24',
      body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_existing_draft',
      created: false,
    });
    expect(calls.some((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBe(false);
  });

  it('lists and claims mention draft items with repository lock metadata', async () => {
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Edited mention draft title',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: 'Todo',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return repositoryLockMetadataResponse();
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_draft_lock' } } } });
        }
        if (request.query?.includes('RainrailProjectIssues')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      mentionDraftProjectItem({
                        id: 'PVTI_manual_draft',
                        title: 'Respond to a manual note',
                        body: 'No Rainrail marker here',
                        status: 'Todo',
                      }),
                      mentionDraftProjectItem({
                        id: 'PVTI_draft_queue',
                        title: 'Edited mention draft title',
                        body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                        status: 'Todo',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    const issues = await provider.listProjectIssues();

    expect(issues).toMatchObject([
      {
        id: 'PVTI_draft_queue',
        title: 'Edited mention draft title',
        contentType: 'DraftIssue',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 24,
      },
    ]);
    await expect(provider.claimProjectIssue({
      issue: issues[0]!,
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
      commentBody: 'started',
    })).resolves.toMatchObject({
      projectItemId: 'PVTI_draft_queue',
      statusFieldId: 'PVTSSF_status',
      statusOptionId: 'status_in_progress',
      agentSessionIdFieldId: 'PVTF_session',
      branchFieldId: 'PVTF_branch',
      lockRefId: 'REF_draft_lock',
      lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
    });
    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
    expect(calls.some((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toBe(true);
  });

  it('does not list mention draft items for a different target agent login', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        if (request.query?.includes('RainrailProjectIssues')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      mentionDraftProjectItem({
                        id: 'PVTI_other_agent_draft',
                        title: 'Respond to reirei-lab/rainrail#24',
                        body: [
                          '<!-- rainrail mention-draft -->',
                          'Mention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
                          'Agent: other-agent',
                          'Repository: reirei-lab/rainrail',
                          'Number: 24',
                        ].join('\n'),
                        status: 'Todo',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toEqual([]);
  });

  it('rejects concurrent mention draft claims with the repository lock', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createdLock = false;
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: 'Todo',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return repositoryLockMetadataResponse();
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailProjectIssues')) {
          return jsonResponse({
            data: {
              organization: {
                projectV2: {
                  items: {
                    nodes: [
                      mentionDraftProjectItem({
                        id: 'PVTI_draft_queue',
                        title: 'Respond to reirei-lab/rainrail#24',
                        body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                        status: 'Todo',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          if (createdLock) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          createdLock = true;
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_draft_lock' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (createdLock && !qualifiedName.includes('dispatched-locks')) {
            return lockRefResponse({
              id: 'REF_draft_lock',
              agentSessionId: 'agent:main:first',
              branchName: 'agent/reirei-lab-rainrail-first',
              projectItemId: 'PVTI_draft_queue',
            });
          }
          return jsonResponse({ data: { node: { ref: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });
    const issue = {
      id: 'PVTI_draft_queue',
      contentType: 'DraftIssue' as const,
      title: 'Respond to reirei-lab/rainrail#24',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      repository: 'reirei-lab/rainrail',
      number: 24,
    };

    await expect(provider.claimProjectIssue({
      issue,
      agentSessionId: 'agent:main:first',
      branchName: 'agent/reirei-lab-rainrail-first',
      commentBody: 'started',
    })).resolves.toMatchObject({ projectItemId: 'PVTI_draft_queue' });
    await expect(provider.claimProjectIssue({
      issue,
      agentSessionId: 'agent:main:second',
      branchName: 'agent/reirei-lab-rainrail-second',
      commentBody: 'started',
    })).rejects.toThrow('Reference already exists');
  });

  it('keeps finalized mention draft claims stable when finalize runs after dispatch', async () => {
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
                status: 'In Progress',
                agentSessionId: 'agent:main:rainrail-draft',
                branchName: 'agent/reirei-lab-rainrail-draft',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      },
      claim: {
        projectItemId: 'PVTI_draft_queue',
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
    })).resolves.toBeUndefined();
    expect(calls.some((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBe(false);
  });

  it('recovers partial mention draft finalize fields', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const updatedAgentSessionId = calls.some((call) => call.variables?.fieldId === 'PVTF_session');
          const updatedBranch = calls.some((call) => call.variables?.fieldId === 'PVTF_branch');
          return jsonResponse({
            data: {
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: '<!-- rainrail mention-draft -->\nMention URL: https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1\nAgent: reirei-agent',
                status: 'In Progress',
                agentSessionId: updatedAgentSessionId ? 'agent:main:rainrail-draft' : '',
                branchName: updatedBranch ? 'agent/reirei-lab-rainrail-draft' : '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
      },
      claim: {
        projectItemId: 'PVTI_draft_queue',
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
    })).resolves.toBeUndefined();
    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue')).map((call) => call.variables?.fieldId)).toEqual([
      'PVTF_session',
      'PVTF_branch',
    ]);
  });

  it('deletes mention draft claim locks after finalize succeeds', async () => {
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
          const updatedAgentSessionId = calls.some((call) => call.variables?.fieldId === 'PVTF_session');
          const updatedBranch = calls.some((call) => call.variables?.fieldId === 'PVTF_branch');
          return jsonResponse({
            data: {
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: calls.some((call) => call.variables?.fieldId === 'PVTSSF_status') ? 'In Progress' : 'Todo',
                agentSessionId: updatedAgentSessionId ? 'agent:main:rainrail-draft' : '',
                branchName: updatedBranch ? 'agent/reirei-lab-rainrail-draft' : '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_draft_lock',
            agentSessionId: 'agent:main:rainrail-draft',
            branchName: 'agent/reirei-lab-rainrail-draft',
            projectItemId: 'PVTI_draft_queue',
          });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_draft_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 24,
      },
      claim: {
        projectItemId: 'PVTI_draft_queue',
        lockRefId: 'REF_draft_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
    })).resolves.toBeUndefined();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_draft_lock',
    });
  });

  it('releases mention draft claim locks when dispatch fails before Project fields change', async () => {
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: 'Todo',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_draft_lock',
            agentSessionId: 'agent:main:rainrail-draft',
            branchName: 'agent/reirei-lab-rainrail-draft',
            projectItemId: 'PVTI_draft_queue',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 24,
      },
      claim: {
        projectItemId: 'PVTI_draft_queue',
        lockRefId: 'REF_draft_lock',
        lockRepositoryId: 'R_repo',
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
      reason: 'dispatch failed',
    })).resolves.toBeUndefined();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_draft_lock',
    });
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
      if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
        return jsonResponse({ data: { node: { ref: null } } });
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
      name: 'refs/notes/rainrail/locks/reirei-lab-rainrail-21-item-21',
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

  it('does not claim normal issues through the draft no-lock path', async () => {
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
                status: 'Todo',
                assignees: ['reirei-agent'],
                defaultBranchRef: null,
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
    })).rejects.toThrow('Project issue claim lock is required for non-draft project issues');

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
  });

  it('does not claim mention drafts without a repository lock', async () => {
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: 'Todo',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailRepositoryLockMetadata')) {
          return jsonResponse({
            data: {
              repository: {
                id: 'R_repo',
                nameWithOwner: 'reirei-lab/rainrail',
                defaultBranchRef: null,
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 24,
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
      commentBody: 'started',
    })).rejects.toThrow('Project issue claim lock is required');

    expect(calls.filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toHaveLength(0);
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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

  it('rejects claims when issue execution conditions change before claim confirmation', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let statusReads = 0;
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
          statusReads += 1;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Todo',
                state: statusReads === 1 ? 'OPEN' : 'CLOSED',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        state: 'OPEN',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('rejects claims when blockers or parent change before claim confirmation', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let statusReads = 0;
    let parentReads = 0;
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
          statusReads += 1;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_22',
                contentId: 'issue_node_22',
                number: 22,
                title: 'Child issue',
                status: 'Backlog',
                assignees: [],
                parent: statusReads === 1
                  ? { repository: 'reirei-lab/rainrail', number: 21 }
                  : { repository: 'reirei-lab/rainrail', number: 99 },
                blockedBy: statusReads === 1 ? [] : [{ repository: 'reirei-lab/rainrail', number: 20, state: 'OPEN' }],
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssues')) {
          parentReads += 1;
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
                        title: 'Parent issue',
                        status: 'Todo',
                        assignees: ['reirei-agent'],
                        blockedBy: parentReads === 1
                          ? []
                          : [{ repository: 'reirei-lab/rainrail', number: 20, state: 'OPEN' }],
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        state: 'OPEN',
        status: 'Backlog',
        assigneeLogins: [],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
      commentBody: 'started',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('rejects child claims when the parent project item is no longer claimable', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let parentReads = 0;
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
                id: 'item_22',
                contentId: 'issue_node_22',
                number: 22,
                title: 'Child issue',
                status: 'Backlog',
                assignees: [],
                parent: { repository: 'reirei-lab/rainrail', number: 21 },
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssues')) {
          parentReads += 1;
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
                        title: 'Parent issue',
                        status: parentReads === 1 ? 'Todo' : 'Done',
                        assignees: parentReads === 1 ? ['reirei-agent'] : ['other-agent'],
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        state: 'OPEN',
        status: 'Backlog',
        assigneeLogins: [],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
      commentBody: 'started',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('rejects child claims when the parent has an active starting lock', async () => {
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
                id: 'item_22',
                contentId: 'issue_node_22',
                number: 22,
                title: 'Child issue',
                status: 'Backlog',
                assignees: [],
                parent: { repository: 'reirei-lab/rainrail', number: 21 },
              }),
            },
          });
        }
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
                        title: 'Parent issue',
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
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            return lockRefByRepositoryMissingResponse();
          }
          return lockRefByRepositoryResponse({
            id: 'REF_parent_lock',
            createdAt: new Date().toISOString(),
            projectItemId: 'item_21',
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
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
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.claimProjectIssue({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        state: 'OPEN',
        status: 'Backlog',
        assigneeLogins: [],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
      commentBody: 'started',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toBeUndefined();
  });

  it('rejects child finalize when the parent moved out of todo after dispatch', async () => {
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
                id: 'item_22',
                contentId: 'issue_node_22',
                number: 22,
                title: 'Child issue',
                status: 'Backlog',
                assignees: [],
                parent: { repository: 'reirei-lab/rainrail', number: 21 },
              }),
            },
          });
        }
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
                        title: 'Parent issue',
                        status: 'Done',
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
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-22',
            branchName: 'agent/reirei-lab-rainrail-22-child-issue',
            projectItemId: 'item_22',
            originalStatus: 'Backlog',
          });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_lock' } } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'Child issue',
        status: 'Backlog',
        assigneeLogins: [],
        repository: 'reirei-lab/rainrail',
        number: 22,
        parent: { repository: 'reirei-lab/rainrail', number: 21 },
      },
      claim: {
        projectItemId: 'item_22',
        lockRefId: 'REF_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
      },
      agentSessionId: 'agent:main:rainrail-22',
      branchName: 'agent/reirei-lab-rainrail-22-child-issue',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_in_progress')
    )).toBeUndefined();
  });

  it('rechecks queue concurrency before confirming a claim', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig({ maxConcurrentAgentTasks: 1 }),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (isCreateLockCommitRequest(_url)) {
          return lockCommitResponse();
        }
        if (request.query?.includes('RainrailProjectItemStatus')) {
          const itemId = String(request.variables?.itemId ?? request.variables?.id ?? '');
          return jsonResponse({
            data: {
              node: itemId === 'item_99'
                ? projectItem({
                    id: 'item_99',
                    contentId: 'issue_node_99',
                    number: 99,
                    title: 'Already running',
                    status: 'In Progress',
                    assignees: ['reirei-agent'],
                    agentSessionId: 'agent:main:rainrail-99',
                    branchName: 'agent/reirei-lab-rainrail-99-already-running',
                  })
                : projectItem({
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
                        status: 'Todo',
                        assignees: ['reirei-agent'],
                      }),
                      projectItem({
                        id: 'item_99',
                        contentId: 'issue_node_99',
                        number: 99,
                        title: 'Already running',
                        status: 'In Progress',
                        assignees: ['reirei-agent'],
                        agentSessionId: 'agent:main:rainrail-99',
                        branchName: 'agent/reirei-lab-rainrail-99-already-running',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
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
        repository: 'reirei-lab/rainrail',
        number: 21,
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    })).rejects.toThrow('GitHub Project item is no longer claimable');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('does not count its own fresh starting lock while rechecking queue concurrency', async () => {
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
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        return jsonResponse({ data: {} });
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
        repository: 'reirei-lab/rainrail',
        number: 21,
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    })).resolves.toMatchObject({ lockRefId: 'REF_lock' });

    expect(calls.find((call) => call.query?.includes('RainrailProjectIssueClaimLockByRepository'))).toBeUndefined();
  });

  it('fails claim concurrency rechecks when another starting lock cannot be read', async () => {
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
                        status: 'Todo',
                        assignees: ['reirei-agent'],
                      }),
                      projectItem({
                        id: 'item_22',
                        contentId: 'issue_node_22',
                        number: 22,
                        title: 'Other selected issue',
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
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('dispatched-locks')) {
            return lockRefByRepositoryMissingResponse();
          }
          return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({ data: { node: { ref: null } } });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
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
        repository: 'reirei-lab/rainrail',
        number: 21,
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: 'started',
    })).rejects.toThrow('secondary rate limit');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('uses the GitHub response Date header when deciding whether a lock is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2000-01-01T00:30:00.000Z'));
    try {
      const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
      const githubDate = 'Sat, 01 Jan 2000 00:00:30 GMT';
      const provider = createGitHubProjectTaskQueueProvider({
        config: projectConfig(),
        auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
        fetch: (async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
          calls.push(request);
          if (isCreateLockCommitRequest(_url)) {
            return lockCommitResponseWithDate('lock_sha', githubDate);
          }
          if (request.query?.includes('RainrailProjectItemStatus')) {
            return jsonResponseWithDate({
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
            }, githubDate);
          }
          if (request.query?.includes('RainrailProjectMetadata')) {
            return projectMetadataResponseWithDate(githubDate);
          }
          if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json', date: githubDate },
            });
          }
          if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
            const qualifiedName = String(request.variables?.qualifiedName ?? '');
            if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
              return jsonResponseWithDate({ data: { node: { ref: null } } }, githubDate);
            }
            return lockRefResponseWithDate({
              id: 'REF_lock_active',
              createdAt: '2000-01-01T00:00:00.000Z',
            }, githubDate);
          }
          return jsonResponseWithDate({ data: { deleteRef: { clientMutationId: null } } }, githubDate);
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
    } finally {
      vi.useRealTimers();
    }
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
          const createAttempts = calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock')).length;
          if (createAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
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

  it('rejects claims when only the fallback dispatched marker remains', async () => {
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
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            return lockRefResponse({
              id: 'REF_dispatched',
              createdAt: '2000-01-01T00:00:00.000Z',
              dispatchedAt: '2000-01-01T00:01:00.000Z',
              agentSessionId: 'agent:main:rainrail-21',
              branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            });
          }
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        return jsonResponse({ data: {} });
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
      agentSessionId: 'agent:main:rainrail-21-new',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection-new',
      commentBody: 'started',
    })).rejects.toThrow('already has a dispatched claim marker');

    expect(calls.find((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toBeUndefined();
  });

  it('does not claim stale locks when the fallback dispatched marker read fails', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let dispatchedLockReads = 0;
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            dispatchedLockReads += 1;
            if (dispatchedLockReads === 1) {
              return jsonResponse({ data: { node: { ref: null } } });
            }
            return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return lockRefResponse({ id: 'REF_lock_expired', createdAt: '2000-01-01T00:00:00.000Z' });
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
      agentSessionId: 'agent:main:rainrail-21-new',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection-new',
      commentBody: 'started',
    })).rejects.toThrow('secondary rate limit');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(1);
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
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

  it('does not delete a stale lock when it was replaced before cleanup', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createLockAttempts = 0;
    let startingLockReads = 0;
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
          createLockAttempts += 1;
          if (createLockAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            return jsonResponse({ data: { node: { ref: null } } });
          }
          startingLockReads += 1;
          return lockRefResponse(startingLockReads === 1
            ? { id: 'REF_lock_expired', createdAt: '2000-01-01T00:00:00.000Z' }
            : {
                id: 'REF_lock_active',
                createdAt: new Date().toISOString(),
                agentSessionId: 'agent:main:new-runner',
                branchName: 'agent/reirei-lab-rainrail-21-new-runner',
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

    expect(calls.filter((call) => call.query?.includes('RainrailProjectIssueClaimLock'))).toHaveLength(4);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(1);
  });

  it('rechecks fallback dispatched markers before deleting stale locks', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createLockAttempts = 0;
    let dispatchedLockReads = 0;
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
          createLockAttempts += 1;
          if (createLockAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            dispatchedLockReads += 1;
            if (dispatchedLockReads < 3) {
              return jsonResponse({ data: { node: { ref: null } } });
            }
            return lockRefResponse({
              id: 'REF_dispatched',
              createdAt: '2000-01-01T00:00:00.000Z',
              dispatchedAt: '2000-01-01T00:01:00.000Z',
              agentSessionId: 'agent:main:rainrail-21',
              branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            });
          }
          return lockRefResponse({ id: 'REF_lock_expired', createdAt: '2000-01-01T00:00:00.000Z' });
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
    })).rejects.toThrow('already has a dispatched claim marker');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(1);
  });

  it('rechecks stale starting locks immediately before deleting them', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let createLockAttempts = 0;
    let startingLockReads = 0;
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
          createLockAttempts += 1;
          if (createLockAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'Reference already exists' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock_new' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/dispatched-locks/')) {
            return jsonResponse({ data: { node: { ref: null } } });
          }
          startingLockReads += 1;
          if (startingLockReads < 3) {
            return lockRefResponse({ id: 'REF_lock_expired', createdAt: '2000-01-01T00:00:00.000Z' });
          }
          return lockRefResponse({
            id: 'REF_lock_expired',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
    expect(calls.filter((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toHaveLength(1);
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

  it('keeps release status in progress when clearing tracking fields fails', async () => {
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
        if (
          request.query?.includes('updateProjectV2ItemFieldValue')
          && request.variables?.fieldId === 'PVTF_branch'
        ) {
          return new Response(JSON.stringify({ errors: [{ message: 'branch clear failed' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
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
    })).rejects.toThrow('branch clear failed');

    const updateValues = calls
      .filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))
      .map((call) => JSON.stringify(call.variables?.value));
    expect(updateValues).toEqual([
      '{"text":""}',
      '{"text":""}',
      '{"text":""}',
    ]);
  });

  it('retries release when status update fails after tracking fields were cleared', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    let statusRead = 0;
    let statusUpdate = 0;
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
        if (request.query?.includes('RainrailProjectItemStatus')) {
          statusRead += 1;
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'In Progress',
                assignees: ['reirei-agent'],
                agentSessionId: statusRead === 1 ? 'agent:main:rainrail-21' : '',
                branchName: statusRead === 1 ? 'agent/reirei-lab-rainrail-21-project-issue-selection' : '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        if (
          request.query?.includes('updateProjectV2ItemFieldValue')
          && JSON.stringify(request.variables?.value) === '{"singleSelectOptionId":"status_todo"}'
        ) {
          statusUpdate += 1;
          if (statusUpdate === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'status update failed' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    const releaseInput = {
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue' as const,
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21', lockRefId: 'REF_lock' },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    };

    await expect(provider.releaseProjectIssue?.(releaseInput)).rejects.toThrow('status update failed');
    await expect(provider.releaseProjectIssue?.(releaseInput)).resolves.toBeUndefined();

    expect(calls.filter((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value) === '{"singleSelectOptionId":"status_todo"}'
    )).toHaveLength(2);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock',
    });
  });

  it('retries partial releases with configured in-progress status names', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig({ inProgressStatus: 'Working' }),
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
                status: 'Working',
                assignees: ['reirei-agent'],
                agentSessionId: '',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse({ inProgressStatusName: 'Working', inProgressStatusOptionId: 'status_working' });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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

    expect(calls.some((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value) === '{"singleSelectOptionId":"status_todo"}'
    )).toBe(true);
  });

  it('uses the claim lock repository to retry DraftIssue partial releases', async () => {
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
              node: mentionDraftProjectItem({
                id: 'PVTI_draft_queue',
                title: 'Respond to reirei-lab/rainrail#24',
                body: mentionDraftBody('https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1'),
                status: 'In Progress',
                agentSessionId: '',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_draft_lock',
            agentSessionId: 'agent:main:rainrail-draft',
            branchName: 'agent/reirei-lab-rainrail-draft',
            projectItemId: 'PVTI_draft_queue',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_draft_queue' } } } });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
      issue: {
        id: 'PVTI_draft_queue',
        contentType: 'DraftIssue',
        title: 'Respond to reirei-lab/rainrail#24',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/24#issuecomment-1',
        repository: 'reirei-lab/rainrail',
        number: 24,
      },
      claim: {
        projectItemId: 'PVTI_draft_queue',
        lockRefId: 'REF_draft_lock',
        lockRepositoryId: 'R_repo',
      },
      agentSessionId: 'agent:main:rainrail-draft',
      branchName: 'agent/reirei-lab-rainrail-draft',
      reason: 'dispatch failed',
    })).resolves.toBeUndefined();

    expect(calls.find((call) => call.query?.includes('RainrailProjectIssueClaimLock'))?.variables).toEqual({
      repositoryId: 'R_repo',
      qualifiedName: 'notes/rainrail/locks/reirei-lab-rainrail-24-pvti-draft-queue',
    });
    expect(calls.some((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value) === '{"singleSelectOptionId":"status_todo"}'
    )).toBe(true);
  });

  it('continues release lock cleanup when clearing tracking fields keeps failing', async () => {
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
        if (
          request.query?.includes('updateProjectV2ItemFieldValue')
          && JSON.stringify(request.variables?.value) === '{"text":""}'
        ) {
          return new Response(JSON.stringify({ errors: [{ message: 'field clear failed' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
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
    })).rejects.toThrow('field clear failed');

    expect(calls.filter((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value) === '{"text":""}'
    )).toHaveLength(2);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value) === '{"singleSelectOptionId":"status_todo"}'
    )).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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

  it('does not delete a release lock when the lock was recreated by another runner', async () => {
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
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:new-runner',
            branchName: 'agent/reirei-lab-rainrail-21-new-runner',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: { projectItemId: 'item_21', lockRefId: 'REF_lock' },
      agentSessionId: 'agent:main:old-runner',
      branchName: 'agent/reirei-lab-rainrail-21-old-runner',
      reason: 'failed_to_start_agent',
    })).resolves.toBeUndefined();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('does not treat transient release lock read failures as missing locks', async () => {
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
                status: 'Todo',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
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
      reason: 'failed_to_start_agent',
    })).rejects.toThrow('secondary rate limit');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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

  it('rolls back status-only partial releases when an owned starting lock remains', async () => {
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
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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

    const updateValues = calls
      .filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))
      .map((call) => JSON.stringify(call.variables?.value));
    expect(updateValues).toEqual([
      '{"text":""}',
      '{"text":""}',
      '{"singleSelectOptionId":"status_todo"}',
    ]);
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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

  it('records the dispatched marker before finalize metadata reloads can fail', async () => {
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
          const metadataRequests = calls.filter((call) => call.query?.includes('RainrailProjectMetadata')).length;
          if (metadataRequests > 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'metadata unavailable' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return projectMetadataResponse();
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            projectItemId: 'item_21',
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
    })).rejects.toThrow('metadata unavailable');

    const markerIndex = calls.findIndex((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock'));
    const metadataIndices = calls.flatMap((call, index) =>
      call.query?.includes('RainrailProjectMetadata') ? [index] : []
    );
    const failedMetadataIndex = metadataIndices[1] ?? -1;
    expect(markerIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeLessThan(failedMetadataIndex);
  });

  it('retries recording the dispatched marker before finalizing a claim', async () => {
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
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          const markerAttempts = calls.filter((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock')).length;
          if (markerAttempts === 1) {
            return new Response(JSON.stringify({ errors: [{ message: 'updateRef rate limited' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            projectItemId: 'item_21',
          });
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
    })).resolves.toBeUndefined();

    expect(calls.filter((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock'))).toHaveLength(2);
  });

  it('creates a fallback dispatched marker when updating the starting lock keeps failing', async () => {
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
          const name = String(request.variables?.name ?? '');
          return jsonResponse({ data: { createRef: { ref: { id: name.includes('dispatched-locks') ? 'REF_dispatched' : 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'updateRef rate limited' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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
    })).resolves.toBeUndefined();

    expect(calls.find((call) =>
      call.query?.includes('RainrailCreateProjectIssueClaimLock')
      && String(call.variables?.name).includes('refs/notes/rainrail/dispatched-locks/')
    )).toBeDefined();
    expect(calls.find((call) =>
      call.query?.includes('RainrailDeleteProjectIssueClaimLock')
      && call.variables?.refId === 'REF_dispatched'
    )).toBeDefined();
  });

  it('finalizes project fields when dispatched marker writes keep failing', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'updateRef rate limited' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'createRef rate limited' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
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

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        contentId: 'issue_node_21',
        lockRefId: 'REF_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
        commentBody: 'started',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).resolves.toBeUndefined();

    const updateValues = calls
      .filter((call) => call.query?.includes('updateProjectV2ItemFieldValue'))
      .map((call) => JSON.stringify(call.variables?.value));
    expect(updateValues).toEqual([
      '{"singleSelectOptionId":"status_in_progress"}',
      '{"text":"agent:main:rainrail-21"}',
      '{"text":"agent/reirei-lab-rainrail-21-project-issue-selection"}',
    ]);
  });

  it('rejects fallback dispatched markers when the starting lock owner changed', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock_new',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:new-runner',
            branchName: 'agent/reirei-lab-rainrail-21-new-runner',
          });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return new Response(JSON.stringify({ errors: [{ message: 'updateRef rate limited' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        lockRefId: 'REF_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).rejects.toThrow('claim lock is no longer owned');

    expect(calls.find((call) => call.query?.includes('RainrailCreateProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
  });

  it('verifies the current claim lock owner before marking it dispatched', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: new Date().toISOString(),
            agentSessionId: 'agent:main:other-runner',
            branchName: 'agent/reirei-lab-rainrail-21-other-runner',
          });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        lockRefId: 'REF_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).rejects.toThrow('claim lock is no longer owned');

    expect(calls.find((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
  });

  it('stops finalize when claim lock ownership cannot be verified before dispatch', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return jsonResponse({
            errors: [{ message: 'secondary rate limit' }],
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.finalizeProjectIssueClaim?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        lockRefId: 'REF_lock',
        lockRepositoryId: 'R_repo',
        lockRepositoryNameWithOwner: 'reirei-lab/rainrail',
        lockDefaultBranchOid: 'base_sha',
        lockDefaultBranchTreeOid: 'base_tree',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
    })).rejects.toThrow('claim lock ownership could not be verified');

    expect(calls.find((call) => call.query?.includes('RainrailUpdateProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
  });

  it('treats todo items with dispatched locks as in progress while listing', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_in_progress')
    )).toBeDefined();
  });

  it('cleans up finalized dispatched locks instead of restoring todo items', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock_dispatched',
    });
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_in_progress')
    )).toBeUndefined();
  });

  it('keeps dispatched markers when finalized claims were moved back to todo', async () => {
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
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
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
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
  });

  it('does not restore dispatched locks after the current status leaves the queue', async () => {
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
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'Done' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_in_progress')
    )).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('does not restore dispatched locks after the current issue becomes closed', async () => {
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
        if (request.query?.includes('RainrailProjectItemStatus')) {
          return jsonResponse({
            data: {
              node: projectItem({
                id: 'item_21',
                contentId: 'issue_node_21',
                number: 21,
                title: 'Project issue selection',
                status: 'Todo',
                state: 'CLOSED',
                assignees: ['reirei-agent'],
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'Todo', state: 'CLOSED' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('status_in_progress')
    )).toBeUndefined();
  });

  it('does not restore dispatched locks over a different in-progress owner', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
  });

  it('continues listing when non-queue lock cleanup cannot read a ref', async () => {
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
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
                        title: 'Done issue',
                        status: 'Done',
                        assignees: ['reirei-agent'],
                      }),
                      projectItem({
                        id: 'item_22',
                        contentId: 'issue_node_22',
                        number: 22,
                        title: 'Ready issue',
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
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('-21-')) {
            return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return lockRefByRepositoryMissingResponse();
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'Done' },
      { id: 'item_22', status: 'Todo' },
    ]);
  });

  it('treats todo items with active starting locks as in progress while listing', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_active',
            createdAt: new Date().toISOString(),
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) => call.query?.includes('RainrailProjectIssueClaimLock'))?.variables).toMatchObject({
      qualifiedName: 'notes/rainrail/locks/reirei-lab-rainrail-21-item-21',
    });
  });

  it('restores status-only dispatched claims while listing', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('agent:main:rainrail-21')
    )).toBeDefined();
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('agent/reirei-lab-rainrail-21-project-issue-selection')
    )).toBeDefined();
  });

  it('restores dispatched claims when only one tracking field is missing', async () => {
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
                        agentSessionId: 'agent:main:rainrail-21',
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
                agentSessionId: 'agent:main:rainrail-21',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables?.value).includes('agent/reirei-lab-rainrail-21-project-issue-selection')
    )).toBeDefined();
  });

  it('cleans up dispatched locks when the start comment fails after fields are finalized', async () => {
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
          return jsonResponse({ data: { createRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('RainrailUpdateProjectIssueClaimLock')) {
          return jsonResponse({ data: { updateRef: { ref: { id: 'REF_lock' } } } });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            projectItemId: 'item_21',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        if (request.query?.includes('addComment')) {
          return new Response(JSON.stringify({ errors: [{ message: 'comment failed' }] }), {
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
    })).resolves.toBeUndefined();

    expect(calls.find((call) => call.query?.includes('addComment'))).toBeDefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeDefined();
  });

  it('retries cleanup for dispatched locks left after fields were finalized', async () => {
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
                        agentSessionId: 'agent:main:rainrail-21',
                        branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock_dispatched',
    });
  });

  it('keeps fallback dispatched markers when starting lock lookup fails during cleanup', async () => {
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
                        agentSessionId: 'agent:main:rainrail-21',
                        branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/locks/')) {
            return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return lockRefResponse({
            id: 'REF_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('retries cleanup for dispatched locks after a finalized issue leaves in progress', async () => {
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
                        status: 'Done',
                        assignees: ['reirei-agent'],
                        agentSessionId: 'agent:main:rainrail-21',
                        branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
                      }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))?.variables).toEqual({
      refId: 'REF_lock_dispatched',
    });
  });

  it('keeps dispatched locks when a non-in-progress issue is not finalized with the lock owner', async () => {
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
                        status: 'Done',
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
                status: 'Done',
                assignees: ['reirei-agent'],
                agentSessionId: '',
                branchName: '',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefByRepositoryResponse({
            id: 'REF_lock_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) => call.query?.includes('RainrailProjectItemStatus'))).toBeDefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('keeps non-in-progress fallback markers when starting lock lookup fails', async () => {
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
                        status: 'Done',
                        assignees: ['reirei-agent'],
                        agentSessionId: 'agent:main:rainrail-21',
                        branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
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
                status: 'Done',
                assignees: ['reirei-agent'],
                agentSessionId: 'agent:main:rainrail-21',
                branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/locks/')) {
            return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return lockRefByRepositoryResponse({
            id: 'REF_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: {} });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('restores partial in-progress claims from fallback dispatched locks', async () => {
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
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('dispatched-locks')) {
            return lockRefResponse({
              id: 'REF_dispatched',
              createdAt: '2000-01-01T00:00:00.000Z',
              dispatchedAt: '2000-01-01T00:01:00.000Z',
              agentSessionId: 'agent:main:rainrail-21',
              branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            });
          }
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: '2000-01-01T00:00:00.000Z',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables).includes('agent:main:rainrail-21')
    )).toBeDefined();
    expect(calls.find((call) =>
      call.query?.includes('RainrailDeleteProjectIssueClaimLock')
      && call.variables?.refId === 'REF_dispatched'
    )).toBeDefined();
  });

  it('does not restore partial in-progress claims over a different owner', async () => {
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
                agentSessionId: 'agent:main:other-runner',
              }),
            },
          });
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('dispatched-locks')) {
            return lockRefResponse({
              id: 'REF_dispatched',
              createdAt: '2000-01-01T00:00:00.000Z',
              dispatchedAt: '2000-01-01T00:01:00.000Z',
              agentSessionId: 'agent:main:rainrail-21',
              branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            });
          }
          return lockRefResponse({
            id: 'REF_lock',
            createdAt: '2000-01-01T00:00:00.000Z',
          });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.listProjectIssues()).resolves.toMatchObject([
      { id: 'item_21', status: 'In Progress' },
    ]);
    expect(calls.find((call) =>
      call.query?.includes('RainrailProjectIssueClaimLock')
      && String(call.variables?.qualifiedName ?? '').includes('dispatched-locks')
    )).toBeDefined();
    expect(calls.find((call) => call.query?.includes('updateProjectV2ItemFieldValue'))).toBeUndefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('restores fallback dispatched locks without deleting markers when starting lock lookup fails', async () => {
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
              }),
            },
          });
        }
        if (request.query?.includes('RainrailProjectMetadata')) {
          return projectMetadataResponse();
        }
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          const qualifiedName = String(request.variables?.qualifiedName ?? '');
          if (qualifiedName.includes('notes/rainrail/locks/')) {
            return new Response(JSON.stringify({ errors: [{ message: 'secondary rate limit' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return lockRefResponse({
            id: 'REF_dispatched',
            createdAt: '2000-01-01T00:00:00.000Z',
            dispatchedAt: '2000-01-01T00:01:00.000Z',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
          });
        }
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await provider.listProjectIssues();

    expect(calls.find((call) =>
      call.query?.includes('updateProjectV2ItemFieldValue')
      && JSON.stringify(call.variables).includes('agent:main:rainrail-21')
    )).toBeDefined();
    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('deletes fallback dispatched markers before starting locks during cleanup', async () => {
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
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          if (request.variables?.refId === 'REF_lock') {
            return new Response(JSON.stringify({ errors: [{ message: 'deleteRef rate limited' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        lockRefId: 'REF_lock',
        dispatchedLockRefId: 'REF_dispatched',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'failed_to_start_agent',
    })).rejects.toThrow('deleteRef rate limited');

    const fallbackDeleteIndex = calls.findIndex((call) =>
      call.query?.includes('RainrailDeleteProjectIssueClaimLock')
      && call.variables?.refId === 'REF_dispatched'
    );
    const startingDeleteIndex = calls.findIndex((call) =>
      call.query?.includes('RainrailDeleteProjectIssueClaimLock')
      && call.variables?.refId === 'REF_lock'
    );
    expect(fallbackDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(startingDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackDeleteIndex).toBeLessThan(startingDeleteIndex);
  });

  it('does not orphan fallback dispatched markers when fallback cleanup fails', async () => {
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
        if (request.query?.includes('RainrailDeleteProjectIssueClaimLock')) {
          if (request.variables?.refId === 'REF_dispatched') {
            return new Response(JSON.stringify({ errors: [{ message: 'delete fallback rate limited' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
        }
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item_21' } } } });
      }) as typeof fetch,
    });

    await expect(provider.releaseProjectIssue?.({
      issue: {
        id: 'item_21',
        contentId: 'issue_node_21',
        contentType: 'Issue',
        title: 'Project issue selection',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
      },
      claim: {
        projectItemId: 'item_21',
        lockRefId: 'REF_lock',
        dispatchedLockRefId: 'REF_dispatched',
      },
      agentSessionId: 'agent:main:rainrail-21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'failed_to_start_agent',
    })).rejects.toThrow('delete fallback rate limited');

    expect(calls.find((call) =>
      call.query?.includes('RainrailDeleteProjectIssueClaimLock')
      && call.variables?.refId === 'REF_lock'
    )).toBeUndefined();
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
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
    })).rejects.toThrow('already has a dispatched claim marker');

    expect(calls.find((call) => call.query?.includes('RainrailDeleteProjectIssueClaimLock'))).toBeUndefined();
  });

  it('uses GitHub committedDate instead of lock metadata createdAt for stale checks', async () => {
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock_existing',
            createdAt: '2000-01-01T00:00:00.000Z',
            committedDate: new Date().toISOString(),
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

  it('queries only open blockers so many closed blockers do not block the queue', async () => {
    const calls: Array<{ query?: string; variables?: Record<string, unknown> }> = [];
    const provider = createGitHubProjectTaskQueueProvider({
      config: projectConfig(),
      auth: { getAuthToken: async () => ({ token: 'project-token', provider: 'configured-token', fallback: false }) },
      fetch: (async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { query?: string; variables?: Record<string, unknown> };
        calls.push(request);
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
                      status: 'Todo',
                      assignees: ['reirei-agent'],
                      blockedByOpenTotal: 0,
                    }),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      }) as typeof fetch,
    });

    const issues = await provider.listProjectIssues();
    expect(issues).toMatchObject([{ id: 'item_21' }]);
    expect(issues[0]?.blockedBy).toBeUndefined();
    expect(calls[0]?.query).toContain('issueDependenciesSummary { blockedBy }');
    expect(calls[0]?.query).toContain('blockedBy(first: 100)');
    expect(calls[0]?.query).not.toContain('states: [OPEN]');
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
        if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
          return lockRefResponse({
            id: 'REF_lock',
            agentSessionId: 'agent:main:rainrail-21',
            branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
            projectItemId: 'item_21',
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

function jsonResponseWithDate(payload: unknown, date: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', date },
  });
}

function isCreateLockCommitRequest(url: string | URL | Request): boolean {
  return String(url).includes('/repos/reirei-lab/rainrail/git/commits');
}

function lockCommitResponse(sha = 'lock_sha'): Response {
  return jsonResponse({ sha });
}

function lockCommitResponseWithDate(sha: string, date: string): Response {
  return jsonResponseWithDate({ sha }, date);
}

function lockRefResponse(input: {
  id?: string;
  createdAt?: string;
  committedDate?: string;
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
            committedDate: input.committedDate ?? createdAt,
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

function lockRefResponseWithDate(input: {
  id?: string;
  createdAt?: string;
  committedDate?: string;
  dispatchedAt?: string;
  agentSessionId?: string;
  branchName?: string;
  projectItemId?: string;
  originalStatus?: string;
}, date: string): Response {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return jsonResponseWithDate({
    data: {
      node: {
        ref: {
          id: input.id ?? 'REF_lock_existing',
          target: {
            oid: 'lock_sha_existing',
            committedDate: input.committedDate ?? createdAt,
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
  }, date);
}

function lockRefByRepositoryResponse(input: {
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
      repository: {
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

function lockRefByRepositoryMissingResponse(): Response {
  return jsonResponse({ data: { repository: { ref: null } } });
}

function projectMetadataResponse(overrides: {
  statusFieldName?: string;
  branchFieldName?: string;
  inProgressStatusName?: string;
  inProgressStatusOptionId?: string;
} = {}): Response {
  const statusFieldName = overrides.statusFieldName ?? 'Status';
  const branchFieldName = overrides.branchFieldName ?? 'Branch';
  const inProgressStatusName = overrides.inProgressStatusName ?? 'In Progress';
  const inProgressStatusOptionId = overrides.inProgressStatusOptionId ?? 'status_in_progress';
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
                  { id: inProgressStatusOptionId, name: inProgressStatusName },
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

function projectMetadataResponseWithDate(date: string): Response {
  return jsonResponseWithDate({
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
          },
        },
      },
    },
  }, date);
}

function repositoryLockMetadataResponse(): Response {
  return jsonResponse({
    data: {
      repository: {
        id: 'R_repo',
        nameWithOwner: 'reirei-lab/rainrail',
        defaultBranchRef: {
          target: {
            oid: 'base_sha',
            tree: { oid: 'base_tree' },
          },
        },
      },
    },
  });
}

function mentionDraftCreationLockResponse(request: { query?: string }): Response | undefined {
  if (request.query?.includes('RainrailRepositoryLockMetadata')) {
    return repositoryLockMetadataResponse();
  }
  if (request.query?.includes('query RainrailProjectIssueClaimLock')) {
    return jsonResponse({ data: { node: { ref: null } } });
  }
  if (request.query?.includes('RainrailCreateProjectIssueClaimLock')) {
    return jsonResponse({ data: { createRef: { ref: { id: 'REF_mention_draft_lock' } } } });
  }
  if (request.query?.includes('deleteRef')) {
    return jsonResponse({ data: { deleteRef: { clientMutationId: null } } });
  }
  return undefined;
}

function mentionDraftBody(commentUrl: string): string {
  return [
    '<!-- rainrail mention-draft -->',
    `Mention URL: ${commentUrl}`,
    'Agent: reirei-agent',
    'Repository: reirei-lab/rainrail',
    'Number: 24',
  ].join('\n');
}

function mentionDraftItemsResponse(items: Array<{
  id: string;
  title: string;
  body: string;
  status: string;
}>): Response {
  return jsonResponse({
    data: {
      organization: {
        projectV2: {
          items: {
            nodes: items.map(mentionDraftProjectItem),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
}

function mentionDraftProjectItem(input: {
  id: string;
  title: string;
  body: string;
  status: string;
  agentSessionId?: string;
  branchName?: string;
}): unknown {
  return {
    id: input.id,
    content: {
      __typename: 'DraftIssue',
      id: `DI_${input.id}`,
      title: input.title,
      body: input.body,
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
  };
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
    if (request.query?.includes('query RainrailProjectIssueClaimLock') || request.query?.includes('RainrailProjectIssueClaimLockByRepository')) {
      return jsonResponse({ data: { node: { ref: null } } });
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
  state?: string;
  agentSessionId?: string;
  branchName?: string;
  parent?: { repository: string; number: number; title?: string; state?: string };
  blockedBy?: Array<{ repository: string; number: number; title?: string; state?: string }>;
  blockedByOpenTotal?: number;
  defaultBranchRef?: unknown;
}): unknown {
  const blockedBy = input.blockedBy ?? [];
  return {
    id: input.id,
    content: {
      __typename: 'Issue',
      id: input.contentId,
      title: input.title,
      state: input.state ?? 'OPEN',
      number: input.number,
      url: `https://github.com/reirei-lab/rainrail/issues/${input.number}`,
      repository: {
        id: 'R_repo',
        nameWithOwner: 'reirei-lab/rainrail',
        defaultBranchRef: input.defaultBranchRef === undefined
          ? { target: { oid: 'base_sha', tree: { oid: 'base_tree' } } }
          : input.defaultBranchRef,
      },
      assignees: { nodes: input.assignees.map((login) => ({ login })) },
      ...(input.parent === undefined
        ? {}
        : {
            parent: {
              number: input.parent.number,
              title: input.parent.title ?? `Issue ${input.parent.number}`,
              state: input.parent.state ?? 'OPEN',
              url: `https://github.com/${input.parent.repository}/issues/${input.parent.number}`,
              repository: { nameWithOwner: input.parent.repository },
            },
          }),
      issueDependenciesSummary: { blockedBy: input.blockedByOpenTotal ?? blockedBy.length },
      blockedBy: {
        totalCount: blockedBy.length,
        nodes: blockedBy.map((blocker) => ({
          number: blocker.number,
          title: blocker.title ?? `Issue ${blocker.number}`,
          state: blocker.state ?? 'OPEN',
          url: `https://github.com/${blocker.repository}/issues/${blocker.number}`,
          repository: { nameWithOwner: blocker.repository },
        })),
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
