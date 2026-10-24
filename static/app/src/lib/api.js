import { invoke } from '@forge/bridge';

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

export async function call(name, payload = {}) {
  const res = await invoke(name, payload);
  if (!res || res.ok !== true) throw new ApiError(res?.error || 'FAILED', res?.message, res?.status);
  return res.data;
}
