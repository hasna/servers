import { render, Box, Text, useInput, useApp } from "ink";
import { getDatabase, closeDatabase } from "../db/database.js";
import { listServers } from "../db/servers.js";
import { listAgents } from "../db/agents.js";
import { listOperations } from "../db/operations.js";
import React from "react";

function Dashboard({ data }: { data: { servers: any[]; agents: any[]; operations: any[] } }) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [activeTab, setActiveTab] = React.useState(0);
  const { servers, agents, operations } = data;

  const tabs = ["Servers", "Agents", "Operations"];
  const items: Record<string, any[]> = {
    Servers: servers,
    Agents: agents,
    Operations: operations,
  };

  const currentItems = items[tabs[activeTab]] || [];

  useInput((input) => {
    if (input === "q" || input === "escape") exit();
    if (input === "j" || input === "arrowDown")
      setSelectedIndex((i: number) => Math.min(i + 1, currentItems.length - 1));
    if (input === "k" || input === "arrowUp")
      setSelectedIndex((i: number) => Math.max(i - 1, 0));
    if (input === "h" || input === "arrowLeft") {
      setActiveTab((t: number) => Math.max(t - 1, 0));
      setSelectedIndex(0);
    }
    if (input === "l" || input === "arrowRight") {
      setActiveTab((t: number) => Math.min(t + 1, tabs.length - 1));
      setSelectedIndex(0);
    }
  });

  const statusColor = (s: string) =>
    ["online", "active", "completed"].includes(s) ? "green" as const
    : ["offline", "failed", "cancelled"].includes(s) ? "red" as const
    : "yellow" as const;

  const itemLabel = (item: any) => {
    if (activeTab === 0) return `${item.name}  ${item.hostname || "-"}`;
    if (activeTab === 1) return `${item.name}  ${item.session_id || "-"}`;
    return `${item.operation_type}  server:${item.server_id.slice(0, 8)}`;
  };

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="cyan"> servers dashboard </Text>
        <Text dimColor> (q to quit) </Text>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          {`Servers: ${servers.length}  |  Agents: ${agents.length}  |  Operations: ${operations.length}`}
        </Text>
      </Box>
      <Box paddingX={1} marginTop={1}>
        {tabs.map((tab, i) => {
          const isActive = i === activeTab;
          return (
            <Text key={tab} bold={isActive} color={isActive ? "cyan" : "gray"}>
              {isActive ? "▸ " : "  "}{tab}{" "}
            </Text>
          );
        })}
      </Box>
      <Box paddingX={1} marginTop={1} flexDirection="column">
        {currentItems.length === 0 ? (
          <Text dimColor>  (none)</Text>
        ) : (
          currentItems.slice(0, 12).map((item, i) => (
            <Box key={item.id}>
              <Text color={i === selectedIndex ? "cyan" : "gray"}>{i === selectedIndex ? "▸ " : "  "}</Text>
              <Text color={statusColor(item.status)}>
                {(item.status || "").slice(0, 3).padEnd(3)}
              </Text>
              <Text> {itemLabel(item)}</Text>
            </Box>
          ))
        )}
      </Box>
      <Box paddingX={1} marginTop={1}>
        <Text dimColor>↑/j↓ navigate  ←/h→ tabs  q quit</Text>
      </Box>
    </Box>
  );
}

export async function startDashboard() {
  const db = getDatabase();
  const data = {
    servers: listServers(undefined, db),
    agents: listAgents("active", db),
    operations: listOperations(undefined, undefined, 20, db),
  };
  closeDatabase();

  render(<Dashboard data={data} />);
}
