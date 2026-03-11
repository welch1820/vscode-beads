/**
 * Main App Component
 *
 * Routes to the appropriate view based on viewType.
 * Manages global state and message passing with the extension.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  Bead,
  BeadsProject,
  BeadsSummary,
  DependencyGraph,
  ExtensionMessage,
  WebviewSettings,
} from "./types";
import { transport } from "./transport";
import { DashboardView } from "./views/DashboardView";
import { IssuesView } from "./views/IssuesView";
import { DetailsView } from "./views/DetailsView";
import { GraphView } from "./views/GraphView";
import { Loading } from "./common/Loading";
import { ToastProvider, triggerToast } from "./common/Toast";

interface AppState {
  viewType: string;
  project: BeadsProject | null;
  projects: BeadsProject[];
  beads: Bead[];
  selectedBead: Bead | null;
  selectedBeadId: string | null;
  summary: BeadsSummary | null;
  graph: DependencyGraph | null;
  highlightedBeadId: string | null;
  loading: boolean;
  error: string | null;
  settings: WebviewSettings;
  teamMembers: string[];
}

const initialState: AppState = {
  viewType: "",
  project: null,
  projects: [],
  beads: [],
  selectedBead: null,
  selectedBeadId: null,
  summary: null,
  graph: null,
  highlightedBeadId: null,
  loading: true,
  error: null,
  settings: { renderMarkdown: true, userId: "", tooltipHoverDelay: 1000 },
  teamMembers: [],
};

export function App(): React.ReactElement {
  const [state, setState] = useState<AppState>(initialState);

  // Handle messages from the extension
  const handleMessage = useCallback((event: MessageEvent<ExtensionMessage>) => {
    const message = event.data;

    switch (message.type) {
      case "setViewType":
        setState((prev) => ({ ...prev, viewType: message.viewType }));
        break;
      case "setProject":
        setState((prev) => ({ ...prev, project: message.project }));
        break;
      case "setProjects":
        setState((prev) => ({ ...prev, projects: message.projects }));
        break;
      case "setBeads":
        setState((prev) => ({ ...prev, beads: message.beads }));
        break;
      case "setBead":
        setState((prev) => ({ ...prev, selectedBead: message.bead }));
        break;
      case "setSelectedBeadId":
        setState((prev) => ({ ...prev, selectedBeadId: (message as { type: "setSelectedBeadId"; beadId: string | null }).beadId }));
        break;
      case "setSummary":
        setState((prev) => ({ ...prev, summary: message.summary }));
        break;
      case "setGraph":
        setState((prev) => ({ ...prev, graph: message.graph }));
        break;
      case "highlightNode":
        setState((prev) => ({ ...prev, highlightedBeadId: message.beadId }));
        break;
      case "setLoading":
        setState((prev) => ({ ...prev, loading: message.loading }));
        break;
      case "setError":
        setState((prev) => ({ ...prev, error: message.error }));
        break;
      case "setSettings":
        setState((prev) => ({ ...prev, settings: message.settings }));
        break;
      case "setTeamMembers":
        setState((prev) => ({ ...prev, teamMembers: message.members }));
        break;
      case "refresh":
        transport.postMessage({ type: "refresh" });
        break;
      case "showToast":
        triggerToast(message.text, "top-right");
        break;
    }
  }, []);

  useEffect(() => {
    // Listen for messages from the extension
    window.addEventListener("message", handleMessage);

    // Notify extension that webview is ready
    transport.postMessage({ type: "ready" });

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [handleMessage]);

  // Render the appropriate view
  const renderView = () => {
    // Only show loading for beadsPanel when loading initial data
    if (state.viewType === "beadsPanel" && state.loading && state.beads.length === 0) {
      return <Loading />;
    }

    switch (state.viewType) {
      case "beadsDashboard":
        return (
          <DashboardView
            summary={state.summary}
            beads={state.beads}
            loading={state.loading}
            error={state.error}
            projects={state.projects}
            activeProject={state.project}
            onSelectProject={(projectId) =>
              transport.postMessage({ type: "selectProject", projectId })
            }
            onSelectBead={(beadId) =>
              transport.postMessage({ type: "openBeadDetails", beadId })
            }
            onRetry={() =>
              transport.postMessage({ type: "refresh" })
            }
          />
        );

      case "beadsPanel":
        return (
          <IssuesView
            beads={state.beads}
            loading={state.loading}
            error={state.error}
            selectedBeadId={state.selectedBeadId}
            projects={state.projects}
            activeProject={state.project}
            tooltipHoverDelay={state.settings.tooltipHoverDelay}
            onSelectProject={(projectId) =>
              transport.postMessage({ type: "selectProject", projectId })
            }
            onSelectBead={(beadId) =>
              transport.postMessage({ type: "openBeadDetails", beadId })
            }
            onUpdateBead={(beadId, updates) =>
              transport.postMessage({ type: "updateBead", beadId, updates })
            }
            onRetry={() =>
              transport.postMessage({ type: "refresh" })
            }
          />
        );

      case "beadsDetails": {
        if (!state.selectedBead && !state.loading) {
          return (
            <div className="empty-state compact">
              <p>Select an issue to view details</p>
            </div>
          );
        }
        if (!state.selectedBead) {
          return <Loading />;
        }
        // Merge team members (git + config) with assignees from existing beads
        const knownAssignees = Array.from(
          new Set([
            ...state.teamMembers,
            ...state.beads.map((b) => b.assignee).filter((a): a is string => !!a),
          ])
        ).sort();
        return (
          <DetailsView
            bead={state.selectedBead}
            allBeads={state.beads}
            loading={state.loading}
            renderMarkdown={state.settings.renderMarkdown}
            userId={state.settings.userId}
            knownAssignees={knownAssignees}
            onUpdateBead={(beadId, updates) =>
              transport.postMessage({ type: "updateBead", beadId, updates })
            }
            onAddDependency={(beadId, targetId, dependencyType, reverse) =>
              transport.postMessage({ type: "addDependency", beadId, targetId, dependencyType, reverse })
            }
            onRemoveDependency={(beadId, dependsOnId) =>
              transport.postMessage({ type: "removeDependency", beadId, dependsOnId })
            }
            onAddComment={(beadId, text) =>
              transport.postMessage({ type: "addComment", beadId, text })
            }
            onViewInGraph={(beadId) =>
              transport.postMessage({ type: "viewInGraph", beadId })
            }
            onSelectBead={(beadId) =>
              transport.postMessage({ type: "openBeadDetails", beadId })
            }
            onCopyId={(beadId) =>
              transport.postMessage({ type: "copyBeadId", beadId })
            }
            onDeleteBead={(beadId) =>
              transport.postMessage({ type: "deleteBead", beadId })
            }
          />
        );
      }

      case "beadsGraph":
        return (
          <GraphView
            graph={state.graph}
            loading={state.loading}
            error={state.error}
            highlightedBeadId={state.highlightedBeadId}
            onSelectBead={(beadId) =>
              transport.postMessage({ type: "openBeadDetails", beadId })
            }
          />
        );

      default:
        return (
          <div className="empty-state">
            <p>Loading...</p>
          </div>
        );
    }
  };

  return (
    <ToastProvider>
      <div className="app">
        <main className="app-content">{renderView()}</main>
      </div>
    </ToastProvider>
  );
}
