"""The WAV leaves the machine by streamed PUT to a signed Supabase URL.

Round 12's discipline, in Python: the render worker learned that fetch()
retains the request body even when "streaming" and OOM'd on 1.2 GB uploads;
its fix was http.request + createReadStream. The equivalent here is
requests.put(data=<file object>): requests reads the Content-Length from
fstat and streams the file in chunks — constant memory for a ~130 MB WAV.

The bytes go worker -> Supabase Storage directly. The signed URL is created
app-side at submission and rides the job payload; the Cloudflare Workers app
layer never sees a byte of audio.
"""

from __future__ import annotations

import os


class UploadFailure(Exception):
    """Worded for the project failure message; detail goes in parentheses."""


def upload_wav(path: str, signed_url: str, put=None) -> int:
    """PUTs the finished WAV. Returns the byte count sent.

    `put` is a test seam (requests.put-compatible). Every failure is a worded
    UploadFailure: an upload that fails must fail the job loudly — the
    alternative is a project whose transcript exists but whose audio does not,
    which is the silent-partial class this design excludes.
    """
    if put is None:
        import requests

        put = requests.put

    size = os.path.getsize(path)
    try:
        with open(path, "rb") as body:
            response = put(
                signed_url,
                data=body,
                headers={
                    "Content-Type": "audio/wav",
                    "Content-Length": str(size),
                },
                timeout=600,
            )
    except Exception as err:  # noqa: BLE001 — every transport error is terminal here
        raise UploadFailure(
            f"The narration could not be saved to storage. Please try again. "
            f"(internal: upload transport error: {err})"
        ) from err

    if not (200 <= response.status_code < 300):
        body_excerpt = ""
        try:
            body_excerpt = response.text[:200]
        except Exception:  # noqa: BLE001
            pass
        raise UploadFailure(
            f"The narration could not be saved to storage. Please try again. "
            f"(internal: upload returned HTTP {response.status_code}: {body_excerpt})"
        )
    return size
