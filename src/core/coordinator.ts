/**
 * Coordinator + signaling HTTP clients — `coordinator.rs` and `signaling.rs`.
 *
 * Cloud coordinator:
 *   POST   /sessions                 create a session
 *   GET    /sessions/{id}            poll until the runtime accepted it
 *   DELETE /sessions/{id}            terminate (creator only)
 *   POST   /sessions/{id}/uploads    create a presigned upload
 *
 * Local runtime (`local: true`):
 *   POST /start_session · GET /session · POST /stop_session
 *
 * Signaling, under `{api}/sessions/{id}/transport/webrtc`:
 *   GET  ice_servers
 *   POST connections                              → { connection_id }
 *   POST|PUT connections/{cid}/sdp_params         ← offer (PUT on reconnect)
 *   GET  connections/{cid}/sdp_params             → 202 (retry) | 200 answer
 *   POST connections/{cid}/ice_candidates         ← trickled candidates
 */
import { invalidState, terminalSession, timedOut } from './errors';
import { checkStatus, readJson, type AuthProvider, type HttpClient } from './http';
import {
  API_ACCEPT_VERSION_HEADER,
  API_VERSION_HEADER,
  REACTOR_API_VERSION,
  REACTOR_WEBRTC_VERSION,
  WEBRTC_VERSION_HEADER,
  backoff,
  isSessionReady,
  isTerminalSessionState,
  sleep,
  type ClientInfo,
  type CreateUploadResponse,
  type IceCandidate,
  type IceServer,
  type PollConfig,
  type SdpAnswerResponse,
  type SessionResponse,
  type TrackMappingEntry,
} from './protocol';

export interface CoordinatorConfig {
  apiUrl: string;
  modelName: string;
  clientInfo: ClientInfo;
  extraArgs?: Record<string, unknown> | undefined;
  sessionPoll: PollConfig;
  local: boolean;
}

export class Coordinator {
  readonly apiUrl: string;
  private localSession: SessionResponse | undefined;

  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthProvider,
    private readonly config: CoordinatorConfig,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '');
  }

  get clientInfo(): ClientInfo {
    return this.config.clientInfo;
  }

  transportBaseUrl(sessionId: string): string {
    return `${this.apiUrl}/sessions/${sessionId}/transport/webrtc`;
  }

  private async headers(jsonBody: boolean, authenticated = true): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      [API_VERSION_HEADER]: REACTOR_API_VERSION,
      [API_ACCEPT_VERSION_HEADER]: REACTOR_API_VERSION,
    };
    if (jsonBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (authenticated) {
      const jwt = await this.auth.jwt();
      if (jwt) {
        headers.Authorization = `Bearer ${jwt}`;
      }
    }
    return headers;
  }

  async createSession(): Promise<SessionResponse> {
    if (this.config.local) {
      const response = await this.http({
        method: 'POST',
        url: `${this.apiUrl}/start_session`,
        headers: await this.headers(true, false),
        body: JSON.stringify(this.config.extraArgs ? { extra_args: this.config.extraArgs } : {}),
      });
      await checkStatus(response, 'start session');
      const session = await readJson<SessionResponse>(response, 'start session');
      this.localSession = session;
      return session;
    }
    const body: Record<string, unknown> = {
      model: { name: this.config.modelName },
      client_info: this.config.clientInfo,
      supported_transports: [{ protocol: 'webrtc', version: REACTOR_WEBRTC_VERSION }],
    };
    if (this.config.extraArgs !== undefined) {
      body.extra_args = this.config.extraArgs;
    }
    const response = await this.http({
      method: 'POST',
      url: `${this.apiUrl}/sessions`,
      headers: await this.headers(true),
      body: JSON.stringify(body),
    });
    await checkStatus(response, 'create session');
    return readJson<SessionResponse>(response, 'create session');
  }

  async getSession(sessionId: string): Promise<SessionResponse> {
    const response = await this.http({
      method: 'GET',
      url: `${this.apiUrl}/sessions/${sessionId}`,
      headers: await this.headers(false),
    });
    await checkStatus(response, 'get session');
    return readJson<SessionResponse>(response, 'get session');
  }

  async pollSessionReady(sessionId: string): Promise<SessionResponse> {
    if (this.config.local) {
      if (this.localSession) {
        return this.localSession;
      }
      // Adopt the session a local runtime is already serving — it holds one.
      const response = await this.http({
        method: 'GET',
        url: `${this.apiUrl}/session`,
        headers: await this.headers(false, false),
      });
      await checkStatus(response, 'get local session');
      const session = await readJson<SessionResponse>(response, 'get local session');
      if (session.session_id !== sessionId) {
        throw invalidState(
          `local runtime is serving session ${session.session_id}, not the requested ${sessionId}`,
        );
      }
      if (isTerminalSessionState(session.state)) {
        throw terminalSession(session.state);
      }
      this.localSession = session;
      return session;
    }
    const next = backoff(this.config.sessionPoll);
    for (let attempt = 1; attempt <= this.config.sessionPoll.maxAttempts; attempt++) {
      const session = await this.getSession(sessionId);
      if (isTerminalSessionState(session.state)) {
        throw terminalSession(session.state);
      }
      if (isSessionReady(session)) {
        return session;
      }
      await this.wait(next());
    }
    throw timedOut(`session ${sessionId} not ready after ${this.config.sessionPoll.maxAttempts} polls`);
  }

  async terminateSession(sessionId: string): Promise<void> {
    if (this.config.local) {
      try {
        await this.http({
          method: 'POST',
          url: `${this.apiUrl}/stop_session`,
          headers: await this.headers(false, false),
        });
      } catch {
        // Best-effort, as in the core: the runtime may already be gone.
      }
      this.localSession = undefined;
      return;
    }
    const response = await this.http({
      method: 'DELETE',
      url: `${this.apiUrl}/sessions/${sessionId}`,
      headers: await this.headers(false),
    });
    if (response.status === 404) {
      return;
    }
    await checkStatus(response, 'terminate session');
  }

  async createUpload(
    sessionId: string,
    request: { name: string; size: number; mime_type: string },
  ): Promise<CreateUploadResponse> {
    const response = await this.http({
      method: 'POST',
      url: `${this.apiUrl}/sessions/${sessionId}/uploads`,
      headers: await this.headers(true),
      body: JSON.stringify(request),
    });
    await checkStatus(response, 'create upload');
    return readJson<CreateUploadResponse>(response, 'create upload');
  }
}

export class Signaling {
  private readonly baseUrl: string;

  constructor(
    private readonly http: HttpClient,
    private readonly auth: AuthProvider,
    baseUrl: string,
    private readonly clientInfo: ClientInfo,
    private readonly poll: PollConfig,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async headers(jsonBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      [API_VERSION_HEADER]: REACTOR_API_VERSION,
      [API_ACCEPT_VERSION_HEADER]: REACTOR_API_VERSION,
      [WEBRTC_VERSION_HEADER]: REACTOR_WEBRTC_VERSION,
    };
    if (jsonBody) {
      headers['Content-Type'] = 'application/json';
    }
    const jwt = await this.auth.jwt();
    if (jwt) {
      headers.Authorization = `Bearer ${jwt}`;
    }
    return headers;
  }

  async iceServers(): Promise<IceServer[]> {
    const response = await this.http({
      method: 'GET',
      url: `${this.baseUrl}/ice_servers`,
      headers: await this.headers(false),
    });
    await checkStatus(response, 'ice servers');
    return (await readJson<{ ice_servers: IceServer[] }>(response, 'ice servers')).ice_servers;
  }

  async registerConnection(): Promise<number> {
    const response = await this.http({
      method: 'POST',
      url: `${this.baseUrl}/connections`,
      headers: await this.headers(true),
      body: '{}',
    });
    await checkStatus(response, 'register connection');
    return (await readJson<{ connection_id: number }>(response, 'register connection')).connection_id;
  }

  async sendSdpOffer(
    connectionId: number,
    sdpOffer: string,
    trackMapping: TrackMappingEntry[],
    reconnect: boolean,
  ): Promise<void> {
    const response = await this.http({
      method: reconnect ? 'PUT' : 'POST',
      url: `${this.baseUrl}/connections/${connectionId}/sdp_params`,
      headers: await this.headers(true),
      body: JSON.stringify({ sdp_offer: sdpOffer, client_info: this.clientInfo, track_mapping: trackMapping }),
    });
    await checkStatus(response, 'send sdp offer');
  }

  async pollSdpAnswer(connectionId: number): Promise<SdpAnswerResponse> {
    const url = `${this.baseUrl}/connections/${connectionId}/sdp_params`;
    const next = backoff(this.poll);
    for (let attempt = 1; attempt <= this.poll.maxAttempts; attempt++) {
      const response = await this.http({ method: 'GET', url, headers: await this.headers(false) });
      if (response.status === 202) {
        await this.wait(next());
        continue;
      }
      await checkStatus(response, 'poll sdp answer');
      return readJson<SdpAnswerResponse>(response, 'poll sdp answer');
    }
    throw timedOut(`no SDP answer after ${this.poll.maxAttempts} polls`);
  }

  async sendIceCandidates(connectionId: number, candidates: IceCandidate[], isFinal: boolean): Promise<void> {
    const response = await this.http({
      method: 'POST',
      url: `${this.baseUrl}/connections/${connectionId}/ice_candidates`,
      headers: await this.headers(true),
      body: JSON.stringify({ candidates, is_final: isFinal, client_info: this.clientInfo }),
    });
    await checkStatus(response, 'send ice candidates');
  }
}
