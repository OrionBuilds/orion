import { callEdgeFunction, parseEdgeFunctionError } from '../lib/edgeFunction';

/** Short-lived signed URL for a stored call recording (private bucket). */
export async function getRecordingUrl(params: { callSid?: string; callLogId?: string }): Promise<string> {
  const response = await callEdgeFunction('call-recording-url', {
    call_sid: params.callSid,
    call_log_id: params.callLogId,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(parseEdgeFunctionError(err, 'Could not load the recording'));
  }
  const data = await response.json();
  return data.url as string;
}
