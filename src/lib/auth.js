// Permission checks performed as the calling user. Workflow data is read asApp,
// so these checks are the security boundary of the app.

import { route } from '@forge/api';
import { jira } from './jira.js';

export class ForbiddenError extends Error {
  constructor(code = 'FORBIDDEN') {
    super(code);
    this.code = code;
  }
}

export async function myPermissions(keys, projectIdOrKey) {
  const params = new URLSearchParams({ permissions: keys.join(',') });
  if (projectIdOrKey) params.set(/^\d+$/.test(String(projectIdOrKey)) ? 'projectId' : 'projectKey', String(projectIdOrKey));
  const res = await jira(route`/rest/api/3/mypermissions?${params}`, { asUser: true });
  return Object.fromEntries(Object.entries(res?.permissions || {}).map(([k, v]) => [k, !!v.havePermission]));
}

export async function isJiraAdmin() {
  const p = await myPermissions(['ADMINISTER']);
  return !!p.ADMINISTER;
}

export async function canAdministerProject(projectId) {
  const p = await myPermissions(['ADMINISTER_PROJECTS', 'ADMINISTER'], projectId);
  return !!(p.ADMINISTER_PROJECTS || p.ADMINISTER);
}

export async function assertProjectAdmin(projectId) {
  if (!projectId || !(await canAdministerProject(projectId))) throw new ForbiddenError('FORBIDDEN_PROJECT');
}

export async function assertJiraAdmin() {
  if (!(await isJiraAdmin())) throw new ForbiddenError('FORBIDDEN_SITE');
}

/**
 * The calling user's role and what it allows, always computed on the server from Jira's own permissions.
 * The UI only uses this to hide what the server would refuse anyway; every resolver checks again.
 */
export async function userCapabilities(projectId) {
  const [site, proj] = await Promise.all([
    myPermissions(['ADMINISTER']).catch(() => ({})),
    projectId ? myPermissions(['ADMINISTER_PROJECTS', 'CREATE_ISSUES', 'BROWSE_PROJECTS'], projectId).catch(() => ({})) : {},
  ]);
  const jiraAdmin = !!site.ADMINISTER;
  const projectAdmin = jiraAdmin || !!proj.ADMINISTER_PROJECTS;
  return {
    role: jiraAdmin ? 'jira-admin' : projectAdmin ? 'project-admin' : 'none',
    jiraAdmin,
    projectAdmin,
    // company-managed (GLOBAL) workflows can be shared by many projects: only Jira admins may change them
    changeShared: jiraAdmin,
    // team-managed (PROJECT scoped) workflows: admins of the owning project
    changeProjectScoped: projectAdmin,
    createTasks: !!proj.CREATE_ISSUES,
    bulk: jiraAdmin,
  };
}
