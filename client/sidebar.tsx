// Inbox sidebar view: replaces Paseo's default sidebar list and groups workspaces into Pinned, Inbox, Running, Snoozed and Archived.
// State comes from the plugin server (subscription push); this view only reads it and sends actions, never writing Paseo's agent data.
// Layout, statuses, hover actions and snooze presets follow t3code. Differences: opening an agent does not mark it read, and buttons are icon-only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import type { PluginSidebarViewProps, WorkspaceRef } from "@getpaseo/plugin/client";
import { useRpc, useSubscription, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import type { PluginTheme } from "@getpaseo/plugin";
import { actionRpc, stateSubscription, type InboxOp, type InboxStateMap } from "../shared/contract";
import {
  SECTION_ORDER,
  type Section,
  type StatusTone,
  type SnoozeUnit,
  activityTime,
  customSnoozeUntil,
  applyOp,
  isListed,
  recedes,
  relativeTime,
  resolveSnoozePresets,
  rowStatus,
  sectionOf,
  snoozeWakeLabel,
  sortKey,
} from "../shared/inbox";
import { tween, useMountAnim, useToggleAnim, webTransition } from "./anim";

const SECTION_TITLE: Record<Section, string> = {
  pinned: "Pinned",
  inbox: "Inbox",
  working: "Running",
  snoozed: "Snoozed",
  settled: "Archived",
};
// Like t3code: Archived shows 10 at first, and "Show more" adds 25 at a time.
const SETTLED_INITIAL = 10;
const SETTLED_PAGE = 25;
const SHELVES: readonly Section[] = ["working", "snoozed", "settled"];
const FONT = { title: 14, meta: 12, section: 13, chip: 12 };
/** Fixed height for the first line, so swapping status text and hover buttons keeps the row height. */
const LINE1_H = 28;
const ACTION_BOX = 24;
const CHIP_H = 30;

// Declare only the DOM features in use (plugins have no DOM type library).
interface DomNode {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  setAttribute(name: string, value: string): void;
}
function asDom(node: unknown): DomNode | null {
  const n = node as Partial<DomNode> | null;
  return n && typeof n.addEventListener === "function" ? (n as DomNode) : null;
}

/** DOM mouseenter/mouseleave: moving onto a child (a row button) does not count as leaving. */
function useHover(): [React.RefObject<View | null>, boolean] {
  const ref = useRef<View | null>(null);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = asDom(ref.current);
    if (!el) return;
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
    };
  }, []);
  return [ref, hovered];
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A light foreground means a dark theme. Hover and selection use translucent overlays so they match the host sidebar background. */
function overlays(theme: PluginTheme) {
  const fg = theme.colors.foreground;
  let light = 0.9;
  const hex = /^#([0-9a-f]{6})/i.exec(fg);
  const rgb = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(fg);
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    light = (((v >> 16) & 255) + ((v >> 8) & 255) + (v & 255)) / 765;
  } else if (rgb) {
    light = (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 765;
  }
  const dark = light > 0.5;
  return {
    hover: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
    active: dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)",
  };
}

/** Status colors follow t3code: needs you amber, running sky blue, failed red, done green, woke uses the accent. */
function toneColor(theme: PluginTheme, tone: StatusTone): string {
  const c = theme.colors;
  if (tone === "approval") return c.statusWarning;
  if (tone === "working") return "#38bdf8";
  if (tone === "failed") return c.statusDanger;
  if (tone === "done") return c.statusSuccess;
  return c.accent;
}

type Act = (ids: string[], op: InboxOp, until?: number) => void;
type Colors = { hover: string; active: string };

export function InboxSidebar(props: PluginSidebarViewProps) {
  const { theme } = props;
  const now = useNow(20_000);
  const [state, setState] = useState<InboxStateMap>({});
  useSubscription(stateSubscription, {}, (ev) => setState(ev.state));
  const call = useRpc(actionRpc);
  const act = useCallback<Act>(
    (ids, op, until) => {
      if (!ids.length) return;
      // Update locally first so the UI responds at once; the state pushed back by the server replaces it.
      const t = Date.now();
      setState((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = applyOp(prev[id] ?? {}, op, t, until);
        return next;
      });
      void call({ workspaceIds: ids, op, until }).catch(() => {});
    },
    [call],
  );

  const groups = useWorkspaces({
    where: isListed,
    groupBy: (ws) => sectionOf(ws, state[ws.id], undefined, now),
    orderBy: (a, b) => {
      const ea = state[a.id];
      const eb = state[b.id];
      return sortKey(b, eb, sectionOf(b, eb, undefined, now)) - sortKey(a, ea, sectionOf(a, ea, undefined, now));
    },
  });
  const bySection = useMemo(() => {
    const m = new Map<string, readonly WorkspaceRef[]>();
    for (const g of groups) m.set(g.key, g.items);
    return m;
  }, [groups]);

  const colors = useMemo(() => overlays(theme), [theme]);
  // Running, Snoozed and Archived are drawers pinned to the bottom of the sidebar; Running starts expanded, the other two collapsed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ working: false, snoozed: true, settled: true });
  const firstShelf = SHELVES.find((sec) => (bySection.get(sec)?.length ?? 0) > 0);
  // For "Archive all", rows slide out one after another, then everything is committed at once.
  const [sweeping, setSweeping] = useState<ReadonlySet<string>>(new Set());
  const [settledShown, setSettledShown] = useState(SETTLED_INITIAL);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingTop: 4, paddingBottom: 12 }}>
      {SECTION_ORDER.map((section) => {
        const refs = bySection.get(section) ?? [];
        if (refs.length === 0 && section !== "inbox") return null;
        const isCollapsed = collapsed[section] ?? false;
        const shown = section === "settled" ? refs.slice(0, settledShown) : refs;
        const inboxIds = section === "inbox" ? refs.map((r) => r.id) : [];
        return (
          <View key={section} style={section === firstShelf ? { marginTop: "auto", paddingTop: 8 } : { marginTop: 8 }}>
            <SectionHeader
              theme={theme}
              colors={colors}
              title={SECTION_TITLE[section]}
              count={refs.length}
              collapsed={isCollapsed}
              onToggle={() => setCollapsed((c) => ({ ...c, [section]: !isCollapsed }))}
              trailing={
                section === "inbox" && inboxIds.length > 0 ? (
                  <IconButton
                    theme={theme}
                    hoverBg={colors.hover}
                    icon="CheckCheck"
                    label="Mark all done (archive)"
                    onPress={() => {
                      setSweeping(new Set(inboxIds));
                      setTimeout(() => {
                        act(inboxIds, "settle");
                        setSweeping(new Set());
                      }, Math.min(inboxIds.length, 8) * 35 + 220);
                    }}
                  />
                ) : null
              }
            />
            {!isCollapsed ? (
              <SectionBody>
                {section === "inbox" && refs.length === 0 ? <EmptyInbox theme={theme} /> : null}
                {shown.map((ref, i) => (
                  <Row
                    key={ref.key}
                    wsRef={ref}
                    section={section}
                    state={state}
                    act={act}
                    props={props}
                    now={now}
                    colors={colors}
                    sweepDelay={sweeping.has(ref.id) ? Math.min(i, 8) * 35 : null}
                  />
                ))}
                {refs.length > shown.length ? (
                  <View style={{ alignItems: "center", paddingVertical: 2 }}>
                    <IconButton
                      theme={theme}
                      hoverBg={colors.hover}
                      icon="ChevronsDown"
                      label={`Show more (${refs.length - shown.length} left)`}
                      onPress={() => setSettledShown((n) => n + SETTLED_PAGE)}
                    />
                  </View>
                ) : null}
              </SectionBody>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function SectionHeader({
  theme,
  colors,
  title,
  count,
  collapsed,
  onToggle,
  trailing,
}: {
  theme: PluginTheme;
  colors: Colors;
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  trailing: React.ReactNode;
}) {
  const open = useToggleAnim(!collapsed);
  const rotate = open.interpolate({ inputRange: [0, 1], outputRange: ["-90deg", "0deg"] });
  const [ref, hover] = useHover();
  return (
    <View ref={ref} style={{ flexDirection: "row", alignItems: "center", marginHorizontal: 6, paddingRight: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${title}`}
        onPress={onToggle}
        style={[
          { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingVertical: 5, borderRadius: 6 },
          { backgroundColor: hover ? colors.hover : "transparent" },
          webTransition,
        ]}
      >
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
        </Animated.View>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.section, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.section }}>{count}</Text>
      </Pressable>
      {trailing}
    </View>
  );
}

/** Drawer content fades and slides in when expanded. */
function SectionBody({ children }: { children: React.ReactNode }) {
  const v = useMountAnim(180);
  return (
    <Animated.View
      style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }] }}
    >
      {children}
    </Animated.View>
  );
}

function EmptyInbox({ theme }: { theme: PluginTheme }) {
  const v = useMountAnim(260);
  return (
    <Animated.View
      style={{
        opacity: v,
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 32,
        paddingVertical: 10,
      }}
    >
      <Icon name="CircleCheck" size={16} color={theme.colors.statusSuccess} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: FONT.meta }}>Inbox zero</Text>
    </Animated.View>
  );
}

/**
 * One row = a t3code card: the first line has the project name (with a pin icon when pinned) and the status on the right; the second line is the title.
 * On hover the status is replaced by two icons: snooze and done (Archived shows move to inbox; Snoozed shows wake now).
 */
function Row({
  wsRef,
  section,
  state,
  act,
  props,
  now,
  colors,
  sweepDelay,
}: {
  wsRef: WorkspaceRef;
  section: Section;
  state: InboxStateMap;
  act: Act;
  props: PluginSidebarViewProps;
  now: number;
  colors: Colors;
  sweepDelay: number | null;
}) {
  const { theme } = props;
  const ws = useWorkspace(wsRef);
  const [ref, hovered] = useHover();
  const [expanded, setExpanded] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const appear = useMountAnim(220);
  const leave = useRef(new Animated.Value(1)).current;
  const [height, setHeight] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  /** Slide out and collapse first, then commit the action; the row then appears in its new section (with a fade-in). */
  const exit = useCallback(
    (op: InboxOp, until?: number) => {
      if (leaving) return;
      setLeaving(true);
      setSnoozeOpen(false);
      tween(leave, 0, 220).start(() => {
        act([wsRef.id], op, until);
        // Most actions move the row to another section (unmounting this one); if it stays put (e.g. archiving a running agent), spring back.
        setTimeout(() => {
          leave.setValue(1);
          setLeaving(false);
        }, 80);
      });
    },
    [act, leave, leaving, wsRef.id],
  );

  // Archive all: staggered slide-out (the parent commits the actions).
  useEffect(() => {
    if (sweepDelay == null) return;
    setLeaving(true);
    const a = Animated.sequence([Animated.delay(sweepDelay), tween(leave, 0, 200)]);
    a.start();
    return () => {
      a.stop();
      leave.setValue(1);
      setLeaving(false);
    };
  }, [sweepDelay, leave]);

  if (!ws) return null;

  const e = state[ws.id];
  const active = props.active.workspace?.key === wsRef.key;
  const status = rowStatus(ws, e, section, now);
  const faded = recedes(ws, e, section);
  const title = ws.title?.trim() || ws.name || "Untitled";
  const showActions = (hovered || expanded || snoozeOpen) && !leaving;
  const pinned = section === "pinned";
  const muted = theme.colors.foregroundMuted;

  const onLayout = (ev: LayoutChangeEvent) => {
    if (!leaving) setHeight(ev.nativeEvent.layout.height);
  };

  let slot: React.ReactNode;
  if (showActions) {
    slot = (
      <RowActions
        theme={theme}
        colors={colors}
        section={section}
        snoozeOpen={snoozeOpen}
        onSnoozeToggle={() => setSnoozeOpen((v) => !v)}
        exit={exit}
      />
    );
  } else if (status) {
    const c = toneColor(theme, status.tone);
    slot = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
        {status.spin ? <Spinning name={status.icon} color={c} /> : <Icon name={status.icon} size={13} color={c} />}
        <Text style={{ color: c, fontSize: FONT.meta, fontWeight: "500" }}>{status.text}</Text>
      </View>
    );
  } else if (section === "snoozed" && e?.snoozedUntil) {
    slot = (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
        <Icon name="AlarmClock" size={13} color={muted} />
        <Text style={{ color: muted, fontSize: FONT.meta }}>{snoozeWakeLabel(e.snoozedUntil, now)}</Text>
      </View>
    );
  } else {
    slot = <Text style={{ color: muted, fontSize: FONT.meta, paddingHorizontal: 4 }}>{relativeTime(activityTime(ws, e), now)}</Text>;
  }

  return (
    <Animated.View
      style={{
        height: leaving && height != null ? leave.interpolate({ inputRange: [0, 1], outputRange: [0, height] }) : undefined,
        overflow: leaving ? "hidden" : "visible",
      }}
    >
      <Animated.View
        ref={ref}
        onLayout={onLayout}
        style={{
          marginHorizontal: 6,
          opacity: Animated.multiply(appear, leave),
          transform: [
            { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
            { translateX: leave.interpolate({ inputRange: [0, 1], outputRange: [-28, 0] }) },
          ],
        }}
      >
        <View
          style={[
            { borderRadius: 8, backgroundColor: active ? colors.active : hovered ? colors.hover : "transparent" },
            webTransition,
          ]}
        >
          {/* First line: pin + project name, status / action buttons on the right (buttons sit outside the row Pressable so hover isn't lost). */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 10, paddingRight: 4, paddingTop: 2, height: LINE1_H }}>
            {pinned ? (
              <IconButton theme={theme} hoverBg={colors.active} icon="Pin" label="Unpin" size={12} box={20} onPress={() => exit("unpin")} />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={title}
              onPress={() => props.navigation.openWorkspace(wsRef)}
              onLongPress={() => setExpanded((v) => !v)}
              style={{ flex: 1, minWidth: 0, alignSelf: "stretch", justifyContent: "center" }}
            >
              <Text numberOfLines={1} style={{ color: muted, fontSize: FONT.meta, opacity: section === "working" ? 0.7 : 1 }}>
                {ws.projectDisplayName}
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", alignItems: "center", height: LINE1_H }}>{slot}</View>
          </View>
          {/* Second line: title. Read and running rows are dimmed (t3code's recede). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={title}
            onPress={() => props.navigation.openWorkspace(wsRef)}
            onLongPress={() => setExpanded((v) => !v)}
            style={{ paddingLeft: 10, paddingRight: 10, paddingBottom: 7 }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                opacity: section === "working" ? 0.7 : faded ? 0.75 : 1,
                fontSize: FONT.title,
                fontWeight: faded ? "400" : "500",
              }}
            >
              {title}
            </Text>
          </Pressable>
        </View>
        {snoozeOpen ? (
          <SnoozeChips
            theme={theme}
            colors={colors}
            now={now}
            onPick={(until) => {
              setExpanded(false);
              exit("snooze", until);
            }}
          />
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

/** The running status icon keeps spinning. */
function Spinning({ name, color }: { name: string; color: string }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: false }));
    a.start();
    return () => a.stop();
  }, [v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name={name} size={13} color={color} />
    </Animated.View>
  );
}

/** Hover actions: like t3code, just two (snooze and done). They fade and slide in slightly from the right; no text, a tooltip on hover. */
function RowActions({
  theme,
  colors,
  section,
  snoozeOpen,
  onSnoozeToggle,
  exit,
}: {
  theme: PluginTheme;
  colors: Colors;
  section: Section;
  snoozeOpen: boolean;
  onSnoozeToggle: () => void;
  exit: (op: InboxOp, until?: number) => void;
}) {
  const v = useMountAnim(140);
  return (
    <Animated.View
      style={{
        flexDirection: "row",
        gap: 2,
        opacity: v,
        transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
      }}
    >
      {section === "snoozed" ? (
        <IconButton theme={theme} hoverBg={colors.active} icon="AlarmClockOff" label="Wake now" size={15} box={ACTION_BOX} onPress={() => exit("unsnooze")} />
      ) : section !== "settled" ? (
        <IconButton theme={theme} hoverBg={colors.active} icon="Clock" label="Snooze" selected={snoozeOpen} size={15} box={ACTION_BOX} onPress={onSnoozeToggle} />
      ) : null}
      {section === "settled" ? (
        <IconButton theme={theme} hoverBg={colors.active} icon="Undo2" label="Move to inbox" size={15} box={ACTION_BOX} onPress={() => exit("unsettle")} />
      ) : (
        <IconButton theme={theme} hoverBg={colors.active} icon="Check" label="Done (archive)" size={15} box={ACTION_BOX} onPress={() => exit("settle")} />
      )}
    </Animated.View>
  );
}

/** Snooze menu: presets in two equal columns (label on the left, wake time on the right); the last cell is custom (hours / days). */
function SnoozeChips({
  theme,
  colors,
  now,
  onPick,
}: {
  theme: PluginTheme;
  colors: Colors;
  now: number;
  onPick: (until: number) => void;
}) {
  const presets = useMemo(() => resolveSnoozePresets(now), [now]);
  const [custom, setCustom] = useState(false);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 }}>
      {presets.map((o, i) => (
        <Chip
          key={o.id}
          theme={theme}
          colors={colors}
          label={o.label}
          when={o.when}
          delay={i * 30}
          // Recompute at click time so a menu left open doesn't drift.
          onPress={() => onPick(resolveSnoozePresets(Date.now()).find((p) => p.id === o.id)?.until ?? o.until)}
        />
      ))}
      {custom ? (
        <CustomSnooze theme={theme} colors={colors} onPick={onPick} />
      ) : (
        <Chip theme={theme} colors={colors} label="Custom" when="" icon="SlidersHorizontal" wide delay={presets.length * 30} onPress={() => setCustom(true)} />
      )}
    </View>
  );
}

function Chip({
  theme,
  colors,
  label,
  when,
  icon,
  wide,
  delay,
  onPress,
}: {
  theme: PluginTheme;
  colors: Colors;
  label: string;
  when: string;
  icon?: string;
  wide?: boolean;
  delay: number;
  onPress: () => void;
}) {
  const v = useMountAnim(160, delay);
  const [ref, hover] = useHover();
  const fg = hover ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <Animated.View
      ref={ref}
      style={{
        flexBasis: wide ? "100%" : "40%",
        flexGrow: 1,
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Snooze: ${label}`}
        onPress={onPress}
        style={[
          {
            height: CHIP_H,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: wide ? "center" : "space-between",
            gap: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: hover ? colors.hover : "transparent",
          },
          webTransition,
        ]}
      >
        {icon ? <Icon name={icon} size={13} color={fg} /> : null}
        <Text numberOfLines={1} style={{ color: fg, fontSize: FONT.chip }}>
          {label}
        </Text>
        {when ? (
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, opacity: 0.8, fontSize: FONT.chip }}>
            {when}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

/** Custom: type a number, pick hours or days, press Enter or ✓. */
function CustomSnooze({ theme, colors, onPick }: { theme: PluginTheme; colors: Colors; onPick: (until: number) => void }) {
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<SnoozeUnit>("hour");
  const v = useMountAnim(160);
  const amount = Number(text);
  const valid = Number.isFinite(amount) && amount > 0;
  const submit = () => {
    if (valid) onPick(customSnoozeUntil(amount, unit, Date.now()));
  };
  const c = theme.colors;
  return (
    <Animated.View
      style={{
        flexBasis: "100%",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
      }}
    >
      <TextInput
        autoFocus
        value={text}
        onChangeText={(t) => setText(t.replace(/[^\d.]/g, ""))}
        onSubmitEditing={submit}
        keyboardType="decimal-pad"
        placeholder="Amount"
        placeholderTextColor={c.foregroundMuted}
        style={{
          flex: 1,
          minWidth: 0,
          height: CHIP_H,
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: c.border,
          color: c.foreground,
          fontSize: FONT.chip,
        }}
      />
      <View style={{ flexDirection: "row", height: CHIP_H, borderRadius: 8, borderWidth: 1, borderColor: c.border, overflow: "hidden" }}>
        {(["hour", "day"] as const).map((u) => (
          <Pressable
            key={u}
            accessibilityRole="button"
            accessibilityLabel={u === "hour" ? "Hours" : "Days"}
            onPress={() => setUnit(u)}
            style={[
              { paddingHorizontal: 10, justifyContent: "center", backgroundColor: unit === u ? colors.active : "transparent" },
              webTransition,
            ]}
          >
            <Text style={{ color: unit === u ? c.foreground : c.foregroundMuted, fontSize: FONT.chip }}>{u === "hour" ? "Hours" : "Days"}</Text>
          </Pressable>
        ))}
      </View>
      <IconButton theme={theme} hoverBg={colors.active} icon="Check" label="Confirm" size={15} box={CHIP_H} onPress={submit} />
    </Animated.View>
  );
}

function IconButton({
  theme,
  hoverBg,
  icon,
  label,
  onPress,
  selected,
  size = 16,
  box,
}: {
  theme: PluginTheme;
  hoverBg: string;
  icon: string;
  label: string;
  onPress: () => void;
  selected?: boolean;
  size?: number;
  /** Button square size; defaults to the icon size plus 12. */
  box?: number;
}) {
  const [ref, hover] = useHover();
  const press = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    // On web, show the native tooltip so hovering explains the button.
    if (Platform.OS === "web") asDom(ref.current)?.setAttribute("title", label);
  }, [ref, label]);
  const lit = hover || selected;
  return (
    <Animated.View ref={ref} style={{ transform: [{ scale: press }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={() => tween(press, 0.86, 80).start()}
        onPressOut={() => Animated.spring(press, { toValue: 1, friction: 4, tension: 220, useNativeDriver: false }).start()}
        hitSlop={4}
        style={[
          {
            width: box ?? size + 12,
            height: box ?? size + 12,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: lit ? hoverBg : "transparent",
          },
          webTransition,
        ]}
      >
        <Icon name={icon} size={size} color={lit ? theme.colors.foreground : theme.colors.foregroundMuted} />
      </Pressable>
    </Animated.View>
  );
}
