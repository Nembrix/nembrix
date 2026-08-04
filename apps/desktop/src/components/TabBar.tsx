import { Plus, X } from "lucide-react";
import { useStore } from "@/store";

export default function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, selectedConnId, addTab } = useStore();

  // Tabs belong to a session (`connId` = the session id). Only show the ones
  // for the currently-selected session — otherwise clicking another
  // connection leaves the previous session's open tables on screen.
  const visibleTabs = tabs.filter((t) => t.connId === selectedConnId);

  const newTab = () => {
    if (!selectedConnId) return;
    addTab({
      id: crypto.randomUUID(),
      connId: selectedConnId,
      kind: "query",
      title: "Query",
      sql: "",
    });
  };

  return (
    <div className="tab-bar">
      {/* The tab list scrolls horizontally; the +New button stays
          pinned on the right so the user can always reach it even
          when the list has grown past the viewport. */}
      <div className="tab-bar-scroll">
        {visibleTabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="label">{t.title}</span>
            <span
              className="close"
              onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              aria-label="Close tab"
            >
              <X size={11} />
            </span>
          </div>
        ))}
      </div>
      <div className="tab-new" onClick={newTab} title="New query (⌘T)">
        <Plus size={13} />
      </div>
    </div>
  );
}
