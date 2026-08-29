/** Submission validation — extracted so tests never import the listening server. */
export function validateSubmission(body) {
  if (!body || typeof body !== 'object') return 'body must be JSON';
  if (typeof body.job_id !== 'string' || !body.job_id.trim()) return 'job_id is required';
  if (typeof body.brief !== 'string' || body.brief.trim().length < 10) {
    return 'brief must be at least 10 characters';
  }
  if (body.brief.length > 20_000) return 'brief must be under 20,000 characters';
  if (typeof body.model !== 'string' || !body.model.trim()) return 'model is required';
  if (typeof body.api_key !== 'string' || !body.api_key.trim()) return 'api_key is required';
  if (typeof body.upload_url !== 'string' || !body.upload_url.startsWith('https://')) {
    return 'upload_url must be an https URL';
  }
  return null;
}
