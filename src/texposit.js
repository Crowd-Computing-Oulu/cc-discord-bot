// Client for TeXposit's external API (app/integrations/api.py there).
//
// Each Discord user connects their own TeXposit account via /texposit connect,
// which stores a per-user bearer token (TexpositLink, in database.js) that
// TeXposit minted after the user approved the consent screen at
// /integrations/authorize. There is no bot-wide credential — every call is
// scoped to whichever projects that specific user chose to share, and a
// revoke on TeXposit's Connected Apps page takes effect on the very next call.
import axios from 'axios';
import db from './database.js';

const { TexpositLink } = db;

const TEXPOSIT_BASE_URL = process.env.TEXPOSIT_BASE_URL || 'http://localhost:5000';
const APP_SLUG = 'sissy';

export function getAuthorizeUrl(scope = 'read_write') {
  const url = new URL('/integrations/authorize', TEXPOSIT_BASE_URL);
  url.searchParams.set('app', APP_SLUG);
  url.searchParams.set('scope', scope);
  return url.toString();
}

export async function getLink(discordUserId) {
  return TexpositLink.findByPk(discordUserId);
}

export async function saveLink(discordUserId, token, scope) {
  await TexpositLink.upsert({
    userId: discordUserId,
    token,
    scope,
    connectedAt: new Date(),
  });
}

export async function disconnect(discordUserId) {
  await TexpositLink.destroy({ where: { userId: discordUserId } });
}

class TexpositApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function apiRequest(discordUserId, method, path, { params, data } = {}) {
  const link = await getLink(discordUserId);
  if (!link) {
    throw new TexpositApiError(0, 'not_connected');
  }

  try {
    const res = await axios({
      method,
      url: new URL(path, TEXPOSIT_BASE_URL).toString(),
      params,
      data,
      headers: { Authorization: `Bearer ${link.token}` },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // Token was revoked on TeXposit's side — drop the stale local link so
      // the next attempt tells the user to reconnect instead of failing silently.
      await disconnect(discordUserId);
      throw new TexpositApiError(401, 'revoked');
    }
    const message = err.response?.data?.error || err.message;
    throw new TexpositApiError(err.response?.status || 500, message);
  }
}

export async function whoamiWithToken(token) {
  try {
    const res = await axios({
      method: 'GET',
      url: new URL('/api/external/whoami', TEXPOSIT_BASE_URL).toString(),
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    throw new TexpositApiError(err.response?.status || 500, err.response?.data?.error || err.message);
  }
}

export async function createProject(discordUserId, name) {
  const data = await apiRequest(discordUserId, 'POST', '/api/external/projects', { data: { name } });
  return data; // { uuid, name }
}

export async function listProjects(discordUserId) {
  const data = await apiRequest(discordUserId, 'GET', '/api/external/projects');
  return data.projects;
}

export async function listFiles(discordUserId, projectUuid) {
  const data = await apiRequest(discordUserId, 'GET', `/api/external/projects/${projectUuid}/files`);
  return data.files;
}

export async function readFile(discordUserId, projectUuid, path) {
  const data = await apiRequest(discordUserId, 'GET', `/api/external/projects/${projectUuid}/file`, {
    params: { path },
  });
  return data.content;
}

// edits: array of { file, type: 'replace'|'replace_lines'|'insert'|'delete'|'write',
// search, replace, replace_all, start_line, end_line } — same shape as TeXposit's
// own in-app make_edits tool. Never a whole-file overwrite by default: search/replace
// on the exact text you read means a collaborator's concurrent change conflicts
// loudly (the search text no longer matches) instead of silently vanishing under
// a blind rewrite, and it gets the same syntax/output-dir/.bib validation as any
// edit the in-app AI assistant makes.
export async function applyEdits(discordUserId, projectUuid, edits) {
  const data = await apiRequest(discordUserId, 'POST', `/api/external/projects/${projectUuid}/edits`, {
    data: { edits },
  });
  return data.results;
}

export async function createComment(discordUserId, projectUuid, filename, text, startLine) {
  const data = await apiRequest(discordUserId, 'POST', `/api/external/projects/${projectUuid}/comments`, {
    data: { filename, text, start_line: startLine },
  });
  return data;
}

export async function getShareLink(discordUserId, projectUuid, mode = 'view') {
  const data = await apiRequest(discordUserId, 'POST', `/api/external/projects/${projectUuid}/share_link`, {
    data: { mode },
  });
  return data.url;
}

export { TexpositApiError };
