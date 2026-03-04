/**
 * ProjectSelector Component
 *
 * Dropdown for selecting the active Beads project
 */

import React from "react";
import { BeadsProject } from "../types";

interface ProjectSelectorProps {
  projects: BeadsProject[];
  activeProject: BeadsProject | null;
  onSelectProject: (projectId: string) => void;
}

export function ProjectSelector({
  projects,
  activeProject,
  onSelectProject,
}: ProjectSelectorProps): React.ReactElement {
  if (projects.length === 0) {
    return (
      <div className="project-selector empty">
        <span>No projects</span>
      </div>
    );
  }

  if (projects.length === 1) {
    return (
      <div className="project-selector single">
        <span className="project-name">{activeProject?.name || projects[0].name}</span>
        <StatusBadge status={activeProject?.status || "disconnected"} />
      </div>
    );
  }

  return (
    <div className="project-selector">
      <select
        value={activeProject?.id || ""}
        onChange={(e) => onSelectProject(e.target.value)}
        className="project-select"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <StatusBadge status={activeProject?.status || "disconnected"} />
    </div>
  );
}

interface StatusBadgeProps {
  status: "connected" | "disconnected" | "not_initialized";
}

function StatusBadge({ status }: StatusBadgeProps): React.ReactElement {
  const cssClass = status === "connected" ? "daemon-running" : "daemon-stopped";
  const statusClass = `daemon-badge ${cssClass}`;
  const statusText = status === "connected" ? "●" : "○";

  return (
    <span className={statusClass} title={`Status: ${status}`}>
      {statusText}
    </span>
  );
}
