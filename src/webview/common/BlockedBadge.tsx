/**
 * BlockedBadge Component
 *
 * Small indicator shown on beads that have unresolved blocking dependencies.
 */

import React from "react";
import { Icon } from "./Icon";

export function BlockedBadge(): React.ReactElement {
  return (
    <span className="blocked-badge" title="Has unresolved blockers">
      <Icon name="ban" size={10} />
    </span>
  );
}
