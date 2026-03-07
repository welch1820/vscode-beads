import React from "react";

interface SourceBadgeProps {
  source?: "beads" | "bugzilla";
}

export function SourceBadge({ source }: SourceBadgeProps): React.ReactElement | null {
  if (!source || source === "beads") return null;
  return (
    <span className="source-badge source-badge--bugzilla" title="Bugzilla bug">
      BZ
    </span>
  );
}
