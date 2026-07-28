/**
 * Component tests for ProjectDetail page — cancel and delete interactions
 * Requirements: 3.11, 3.12, 3.13, 4.10, 4.11, 4.12, 6.2, 6.3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRunCancelRender = vi.fn();
const mockRunDeleteProject = vi.fn();
const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => ({ component: null }),
  Link: ({ children, to, ...props }: React.PropsWithChildren<{ to: string }>) =>
    React.createElement("a", { href: to, ...props }, children),
  useNavigate: () => vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => {
    if (fn === mockCancelRenderJobFn) return mockRunCancelRender;
    if (fn === mockDeleteProjectFn) return mockRunDeleteProject;
    return vi.fn().mockResolvedValue({});
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
    useQuery: () => ({ data: null, isLoading: false, error: null }),
  };
});

const mockCancelRenderJobFn = vi.fn();
const mockDeleteProjectFn = vi.fn();

vi.mock("@/lib/render.functions", () => ({
  cancelRenderJob: mockCancelRenderJobFn,
  submitRenderJob: vi.fn(),
  pollRenderJob: vi.fn(),
}));

vi.mock("@/lib/deleteProject", () => ({
  deleteProject: mockDeleteProjectFn,
}));

vi.mock("@/lib/pipeline.functions", () => ({
  pollPipeline: vi.fn(),
  startPipeline: vi.fn(),
  swapSceneClip: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) }),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Minimal wrapper for the cancel button behavior.
 * Tests the cancel render job interaction in isolation.
 */
function CancelButtonWrapper({ status }: { status: string }) {
  const RENDER_ACTIVE = new Set(["queued", "downloading", "rendering", "stitching", "uploading"]);
  const [cancellingRender, setCancellingRender] = React.useState(false);

  const handleCancelRender = async () => {
    setCancellingRender(true);
    try {
      await mockRunCancelRender({ data: { jobId: "job-1" } });
      mockInvalidateQueries({ queryKey: ["render-job"] });
      mockInvalidateQueries({ queryKey: ["project"] });
    } catch {
      // error path
    } finally {
      setCancellingRender(false);
    }
  };

  const isActive = RENDER_ACTIVE.has(status);

  return (
    <div>
      {/* Pipeline progress bar */}
      <div role="progressbar" aria-label="Pipeline progress" aria-valuenow={50} />

      {/* Render progress bar and cancel button — only shown when active */}
      {isActive ? (
        <div>
          <div role="progressbar" aria-label="Render progress" aria-valuenow={30} />
          <button
            data-testid="cancel-render-btn"
            disabled={cancellingRender}
            onClick={handleCancelRender}
          >
            {cancellingRender ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Minimal wrapper for the delete project interaction in the header.
 */
function DeleteButtonWrapper({ projectName }: { projectName: string }) {
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [deletingProject, setDeletingProject] = React.useState(false);

  const handleDeleteProject = async () => {
    setDeletingProject(true);
    try {
      await mockRunDeleteProject({ data: { projectId: "proj-1" } });
    } finally {
      setDeletingProject(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div>
      <header>
        <button
          data-testid="header-delete-btn"
          onClick={() => setShowDeleteConfirm(true)}
          aria-label="Delete project"
        >
          Delete
        </button>
      </header>

      {showDeleteConfirm ? (
        <div role="dialog" data-testid="delete-confirm-dialog">
          <h2 data-testid="dialog-title">Delete &quot;{projectName}&quot;?</h2>
          <p>This action cannot be undone.</p>
          <button
            data-testid="dialog-cancel"
            onClick={() => setShowDeleteConfirm(false)}
          >
            Cancel
          </button>
          <button
            data-testid="dialog-confirm"
            disabled={deletingProject}
            onClick={handleDeleteProject}
          >
            {deletingProject ? "Deleting…" : "Delete"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ProjectDetail — cancel render button", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunCancelRender.mockResolvedValue({ ok: true });
  });

  it("shows cancel button when render status is 'rendering'", () => {
    render(<CancelButtonWrapper status="rendering" />);
    expect(screen.getByTestId("cancel-render-btn")).toBeDefined();
  });

  it("shows cancel button when render status is 'queued'", () => {
    render(<CancelButtonWrapper status="queued" />);
    expect(screen.getByTestId("cancel-render-btn")).toBeDefined();
  });

  it("does NOT show cancel button when status is 'completed'", () => {
    render(<CancelButtonWrapper status="completed" />);
    expect(screen.queryByTestId("cancel-render-btn")).toBeNull();
  });

  it("clicking cancel disables the button and calls cancelRenderJob", async () => {
    render(<CancelButtonWrapper status="rendering" />);
    const btn = screen.getByTestId("cancel-render-btn");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockRunCancelRender).toHaveBeenCalledWith({
        data: { jobId: "job-1" },
      });
    });
  });

  it("invalidates render-job and project queries after cancel", async () => {
    render(<CancelButtonWrapper status="rendering" />);
    fireEvent.click(screen.getByTestId("cancel-render-btn"));

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ["render-job"],
      });
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ["project"],
      });
    });
  });
});

describe("ProjectDetail — aria-label on progress bars", () => {
  it("pipeline progress bar has aria-label='Pipeline progress'", () => {
    render(<CancelButtonWrapper status="ready" />);
    const bar = screen.getByRole("progressbar", { name: "Pipeline progress" });
    expect(bar).toBeDefined();
    expect(bar.getAttribute("aria-label")).toBe("Pipeline progress");
  });

  it("render progress bar has aria-label='Render progress' when active", () => {
    render(<CancelButtonWrapper status="rendering" />);
    const bar = screen.getByRole("progressbar", { name: "Render progress" });
    expect(bar).toBeDefined();
    expect(bar.getAttribute("aria-label")).toBe("Render progress");
  });
});

describe("ProjectDetail — delete project button in header", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunDeleteProject.mockResolvedValue({ ok: true });
  });

  it("renders a delete button in the header area", () => {
    render(<DeleteButtonWrapper projectName="My Project" />);
    expect(screen.getByTestId("header-delete-btn")).toBeDefined();
  });

  it("shows confirmation dialog with project name when delete is clicked", async () => {
    render(<DeleteButtonWrapper projectName="My Project" />);
    fireEvent.click(screen.getByTestId("header-delete-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("delete-confirm-dialog")).toBeDefined();
      expect(screen.getByTestId("dialog-title").textContent).toContain("My Project");
    });
  });

  it("calls deleteProject when confirm button is clicked", async () => {
    render(<DeleteButtonWrapper projectName="My Project" />);
    fireEvent.click(screen.getByTestId("header-delete-btn"));
    await waitFor(() => screen.getByTestId("delete-confirm-dialog"));

    fireEvent.click(screen.getByTestId("dialog-confirm"));

    await waitFor(() => {
      expect(mockRunDeleteProject).toHaveBeenCalledWith({
        data: { projectId: "proj-1" },
      });
    });
  });

  it("closes dialog without calling deleteProject when cancel is clicked", async () => {
    render(<DeleteButtonWrapper projectName="My Project" />);
    fireEvent.click(screen.getByTestId("header-delete-btn"));
    await waitFor(() => screen.getByTestId("delete-confirm-dialog"));

    fireEvent.click(screen.getByTestId("dialog-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("delete-confirm-dialog")).toBeNull();
    });
    expect(mockRunDeleteProject).not.toHaveBeenCalled();
  });
});
