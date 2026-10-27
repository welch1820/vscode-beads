import React from "react";

interface SourceBadgeProps {
  source?: "beads" | "bugzilla" | "jira";
}

export function SourceBadge({ source }: SourceBadgeProps): React.ReactElement | null {
  if (!source || source === "beads") return null;
  if (source === "jira") {
    return (
      <span className="source-badge source-badge--jira" title="Jira issue">
        JIRA
      </span>
    );
  }
  return (
    <span className="source-badge source-badge--bugzilla" title="Bugzilla bug">
      BZ
    </span>
  );
}
