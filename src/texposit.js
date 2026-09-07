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

// Server-to-server: what Sissy's own process uses to call the API. In Docker
// this is host.docker.internal, an address meaningless outside the container.
const TEXPOSIT_BASE_URL = process.env.TEXPOSIT_BASE_URL || 'http://localhost:5000';
// Human-facing: what gets put in a link shown to a Discord user, who needs a
// URL their own browser can actually open. Falls back to TEXPOSIT_BASE_URL so
// single-value setups (bare-metal, same host reachable both ways) still work.
const TEXPOSIT_PUBLIC_URL = process.env.TEXPOSIT_PUBLIC_URL || TEXPOSIT_BASE_URL;
const APP_SLUG = 'sissy';

// Self-registers Sissy's app identity (slug/name only — grants zero access
// by itself) so a TeXposit instance never needs a manual admin/CLI step
// before the first /texposit connect. Idempotent server-side; failures are
// swallowed here because the worst case if this doesn't run is the same
// "unknown app" the consent screen already handled before self-registration
// existed, not a broken connect flow.
async function ensureAppRegistered() {
  try {
    await axios.post(
      new URL('/api/external/apps/register', TEXPOSIT_BASE_URL).toString(),
      { slug: APP_SLUG, name: 'Sissy', description: 'Discord bot with LaTeX project access' },
      { timeout: 15000 }
    );
  } catch (err) {
    console.error('[texposit] app self-registration failed:', err.response?.data?.error || err.message);
  }
}

export async function getAuthorizeUrl(scope = 'read_write') {
  await ensureAppRegistered();
  const url = new URL('/integrations/authorize', TEXPOSIT_PUBLIC_URL);
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
      // A 401 here used to be treated as an unconditional revoke and the
      // local link was dropped on the spot. That was wrong: a 401 on one
      // endpoint doesn't prove the token is dead — it can also be a
      // transient hiccup (e.g. right after connecting, before TeXposit has
      // fully propagated the new token). Confirm against /whoami, which is
      // the actual source of truth for "is this token still valid", before
      // throwing away a connection the user still has.
      const stillValid = await whoamiWithToken(link.token).then(() => true).catch(() => false);
      if (!stillValid) {
        await disconnect(discordUserId);
        throw new TexpositApiError(401, 'revoked');
      }
      console.error(
        `[texposit] transient 401 on ${method} ${path} for discord user ${discordUserId} ` +
        `(token still valid per /whoami, link kept). Response: ${JSON.stringify(err.response?.data)}`
      );
      throw new TexpositApiError(409, 'transient_auth_error');
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The model calling these tools sees project names in texposit_projects'
// output and sometimes passes one of those back instead of copying the UUID
// verbatim — indistinguishable from a real "wrong ID" case if we just 404.
// Resolving by name here means that mistake self-corrects instead of
// reporting shared projects as inaccessible.
export async function resolveProjectUuid(discordUserId, projectUuidOrName) {
  if (UUID_RE.test(projectUuidOrName)) return projectUuidOrName;

  const projects = await listProjects(discordUserId);
  const needle = projectUuidOrName.trim().toLowerCase();
  const exact = projects.find(p => p.name.toLowerCase() === needle);
  if (exact) return exact.uuid;
  const partial = projects.find(p => p.name.toLowerCase().includes(needle));
  if (partial) return partial.uuid;

  throw new TexpositApiError(
    404,
    `No shared project matches "${projectUuidOrName}". Shared projects: ${projects.map(p => p.name).join(', ') || '(none)'}`
  );
}

export async function listFiles(discordUserId, projectUuid) {
  const data = await apiRequest(discordUserId, 'GET', `/api/external/projects/${projectUuid}/files`);
  return data.files;
}

export async function readFile(discordUserId, projectUuid, path) {
  const data = await apiRequest(discordUserId, 'GET', `/api/external/projects/${projectUuid}/file`, {
    params: { path },
  });
  if (data.content) return data.content;

  // An empty body is indistinguishable from a genuinely empty file, and
  // trusting it blindly is dangerous: an edit built against "empty" content
  // can end up overwriting real content instead of failing to match. One
  // retry after a short delay rules out the transient case (e.g. hitting
  // TeXposit right as it's still writing the file after a previous edit)
  // before we accept the file really is empty.
  await new Promise(resolve => setTimeout(resolve, 500));
  const retryData = await apiRequest(discordUserId, 'GET', `/api/external/projects/${projectUuid}/file`, {
    params: { path },
  });
  if (!retryData.content) {
    console.error(
      `[texposit] "${path}" in project ${projectUuid} read empty twice for discord user ${discordUserId}. ` +
      `Raw response: ${JSON.stringify(retryData)}`
    );
  }
  return retryData.content;
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
