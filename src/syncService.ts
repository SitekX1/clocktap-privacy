import type React from "react";
import { supabase } from "./supabase";
import type { AppState, Action, Entry, Urlaub, SyncQueueItem } from "./store";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export function generateLocalId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

function msToDatum(ms: number): string {
  return new Date(ms).toISOString().split("T")[0]; // "YYYY-MM-DD"
}

function msToZeit(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function zeitZuMs(datum: string, zeit: string): number {
  return new Date(`${datum}T${zeit}:00`).getTime();
}

// Stabiler numeric ID aus local_id (UUID → hash)
function stableId(local_id: string, offset = 0): number {
  let h = offset;
  for (let j = 0; j < local_id.length; j++) h = (Math.imul(31, h) + local_id.charCodeAt(j)) | 0;
  return Math.abs(h);
}

// Expandiert einen Datumsbereich in einzelne Tage (wie die DB es erwartet)
function expandDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from);
  const end = new Date(to);
  while (cur.getTime() <= end.getTime()) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── Auth-Hilfsfunktion ───────────────────────────────────────────────────────

async function getAuthContext(): Promise<{ userId: string; workspaceId: string } | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .single();

  if (!profile?.workspace_id) return null;
  return { userId: user.id, workspaceId: profile.workspace_id };
}

// ── Workspace-Settings laden ─────────────────────────────────────────────────

export interface WorkspaceSettings {
  workspaceId: string;
  firma: string;
  sollStunden: number;
  pauseMinuten: number;
  pauseNachStunden: number;
  fixPauseZeit: string;
  fixPauseMinuten: number;
  karenzProMonat: number;
  urlaubstageGesamt: number;
  bundesland: string;
  arbeitstageProWoche: number;
  monatlicheAbzugStunden: number;
  monatlicheAbzugModus: "alle" | "monate";
  monatlicheAbzugMonate: number[];
}

export async function loadWorkspaceSettings(): Promise<WorkspaceSettings | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("workspace_id")
    .eq("id", user.id)
    .single();

  if (!profile?.workspace_id) return null;

  const [{ data: member }, { data: workspace }] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("settings")
      .eq("workspace_id", profile.workspace_id)
      .eq("user_id", user.id)
      .single(),
    supabase
      .from("workspaces")
      .select("name, settings")
      .eq("id", profile.workspace_id)
      .single(),
  ]);

  if (!workspace) return null;

  const s = (member?.settings ?? {}) as Record<string, unknown>;
  const ws = (workspace.settings ?? {}) as Record<string, unknown>;

  const num = (a: unknown, b: unknown, def: number): number =>
    typeof a === "number" ? a : typeof b === "number" ? b : def;
  const str = (a: unknown, b: unknown, def: string): string =>
    typeof a === "string" ? a : typeof b === "string" ? b : def;

  return {
    workspaceId: profile.workspace_id,
    firma: workspace.name ?? "",
    sollStunden: num(s.sollStunden, ws.sollStunden, 8),
    pauseMinuten: num(s.pauseMinuten, ws.pauseMinuten, 30),
    pauseNachStunden: num(s.pauseNachStunden, ws.pauseNachStunden, 6),
    fixPauseZeit: str(s.fixPauseZeit, ws.fixPauseZeit, ""),
    fixPauseMinuten: num(s.fixPauseMinuten, ws.fixPauseMinuten, 0),
    karenzProMonat: num(s.karenzProMonat, ws.karenzProMonat, 0),
    urlaubstageGesamt: num(s.urlaubstageGesamt, ws.urlaubstageGesamt, 30),
    bundesland: str(s.bundesland, ws.bundesland, ""),
    arbeitstageProWoche: num(s.arbeitstageProWoche, ws.arbeitstageProWoche, 5),
    monatlicheAbzugStunden: num(s.monatlicheAbzugStunden, ws.monatlicheAbzugStunden, 0),
    monatlicheAbzugModus: (s.monatlicheAbzugModus ?? ws.monatlicheAbzugModus ?? "alle") as "alle" | "monate",
    monatlicheAbzugMonate: (Array.isArray(s.monatlicheAbzugMonate) ? s.monatlicheAbzugMonate : Array.isArray(ws.monatlicheAbzugMonate) ? ws.monatlicheAbzugMonate : []) as number[],
  };
}

// ── Bulk-Upload beim Workspace-Beitritt ──────────────────────────────────────

export async function bulkUploadLocalData(state: AppState, workspaceId: string): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const now = new Date().toISOString();

  // time_entries: ms-Timestamps → datum + start_zeit + end_zeit + pause_minuten
  const timeRows = state.entries
    .filter(e => e.local_id && e.end > 0)
    .map(e => ({
      local_id: e.local_id!,
      user_id: user.id,
      workspace_id: workspaceId,
      datum: msToDatum(e.start),
      start_zeit: msToZeit(e.start),
      end_zeit: msToZeit(e.end),
      pause_minuten: Math.round(e.pause / 60000),
      notiz: null as null,
      updated_at: now,
    }));

  // urlaub: Datumsbereich → ein Row pro Tag
  const urlaubRows: { local_id: string; user_id: string; workspace_id: string; datum: string; typ: string; status: string; approval_state: object; updated_at: string }[] = [];
  for (const u of state.urlaub) {
    if (!u.local_id) continue;
    const days = expandDateRange(u.from, u.to);
    for (let i = 0; i < days.length; i++) {
      urlaubRows.push({
        local_id: i === 0 ? u.local_id : `${u.local_id}_${days[i]}`,
        user_id: user.id,
        workspace_id: workspaceId,
        datum: days[i],
        typ: u.typ,
        status: "pending",
        approval_state: {},
        updated_at: now,
      });
    }
  }

  await Promise.all([
    timeRows.length > 0
      ? supabase.from("time_entries").upsert(timeRows, { onConflict: "local_id" })
      : Promise.resolve(),
    urlaubRows.length > 0
      ? supabase.from("urlaub").upsert(urlaubRows, { onConflict: "local_id" })
      : Promise.resolve(),
  ]);
}

// ── processQueue — laufende Sync ─────────────────────────────────────────────

export async function processQueue(state: AppState): Promise<SyncQueueItem[]> {
  if (!state.settings.cloudSync || state.syncQueue.length === 0) return state.syncQueue;

  const ctx = await getAuthContext();
  if (!ctx) return state.syncQueue;

  const { userId, workspaceId } = ctx;
  const remaining: SyncQueueItem[] = [];
  const now = new Date().toISOString();

  for (const item of state.syncQueue) {
    try {
      if (item.entity === "entry") {
        if (item.op === "delete") {
          await supabase.from("time_entries").delete()
            .eq("local_id", item.local_id)
            .eq("user_id", userId)
            .eq("workspace_id", workspaceId);
        } else {
          const entry = state.entries.find(e => e.local_id === item.local_id);
          if (entry && entry.end > 0) {
            await supabase.from("time_entries").upsert({
              local_id: entry.local_id!,
              user_id: userId,
              workspace_id: workspaceId,
              datum: msToDatum(entry.start),
              start_zeit: msToZeit(entry.start),
              end_zeit: msToZeit(entry.end),
              pause_minuten: Math.round(entry.pause / 60000),
              notiz: null,
              updated_at: now,
            }, { onConflict: "local_id" });
          }
        }
      } else if (item.entity === "urlaub") {
        if (item.op === "delete") {
          // Alle Tages-Rows dieses Eintrags löschen (local_id und local_id_DATUM Pattern)
          const u = state.urlaub.find(x => x.local_id === item.local_id);
          if (u) {
            const days = expandDateRange(u.from, u.to);
            const idsToDelete = [item.local_id, ...days.slice(1).map(d => `${item.local_id}_${d}`)];
            await supabase.from("urlaub").delete()
              .in("local_id", idsToDelete)
              .eq("user_id", userId)
              .eq("workspace_id", workspaceId);
          } else {
            await supabase.from("urlaub").delete()
              .eq("local_id", item.local_id)
              .eq("user_id", userId)
              .eq("workspace_id", workspaceId);
          }
        } else {
          const u = state.urlaub.find(x => x.local_id === item.local_id);
          if (u) {
            const days = expandDateRange(u.from, u.to);
            const rows = days.map((d, i) => ({
              local_id: i === 0 ? u.local_id! : `${u.local_id}_${d}`,
              user_id: userId,
              workspace_id: workspaceId,
              datum: d,
              typ: u.typ,
              status: "pending",
              approval_state: {},
              updated_at: now,
            }));
            await supabase.from("urlaub").upsert(rows, { onConflict: "local_id" });
          }
        }
      }
      // schicht: Tabelle existiert noch nicht — wird in Phase 4 ergänzt
    } catch {
      remaining.push(item);
    }
  }

  return remaining;
}

// ── Pull-Sync — Daten vom Server holen ───────────────────────────────────────

export interface PullResult {
  entries: Entry[];
  urlaub: Urlaub[];
}

export async function pullSync(): Promise<PullResult | null> {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { userId, workspaceId } = ctx;

  const [{ data: timeData }, { data: urlaubData }] = await Promise.all([
    supabase
      .from("time_entries")
      .select("local_id, datum, start_zeit, end_zeit, pause_minuten, updated_at")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId)
      .order("datum", { ascending: false }),
    supabase
      .from("urlaub")
      .select("local_id, datum, typ, status, updated_at")
      .eq("user_id", userId)
      .eq("workspace_id", workspaceId),
  ]);

  const entries: Entry[] = (timeData ?? [])
    .filter(r => r.local_id && r.start_zeit && r.end_zeit)
    .map(r => {
      const startMs = zeitZuMs(r.datum, r.start_zeit);
      const endMs = zeitZuMs(r.datum, r.end_zeit!);
      const pauseMs = (r.pause_minuten ?? 0) * 60000;
      return {
        id: stableId(r.local_id),
        local_id: r.local_id,
        start: startMs,
        end: endMs,
        duration: endMs - startMs,
        pause: pauseMs,
        net: endMs - startMs - pauseMs,
        manual: false,
        updated_at: new Date(r.updated_at).getTime(),
      };
    });

  // Urlaub: jeder Row ist ein einzelner Tag → als from=to=datum zurückgeben
  const urlaub: Urlaub[] = (urlaubData ?? [])
    .filter(r => r.local_id)
    .map(r => ({
      id: stableId(r.local_id, 1),
      local_id: r.local_id,
      from: r.datum,
      to: r.datum,
      typ: r.typ as "urlaub" | "gleittag",
      status: (r.status ?? "pending") as "pending" | "approved" | "rejected",
      updated_at: new Date(r.updated_at).getTime(),
    }));

  return { entries, urlaub };
}

// ── Einzelnen Eintrag direkt pushen (nach Ausstempeln) ──────────────────────

export async function syncEintrag(local_id: string, start: number, end: number, pause: number): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) return;
  await supabase.from("time_entries").upsert({
    local_id,
    user_id: ctx.userId,
    workspace_id: ctx.workspaceId,
    datum: msToDatum(start),
    start_zeit: msToZeit(start),
    end_zeit: msToZeit(end),
    pause_minuten: Math.round(pause / 60000),
    notiz: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "local_id" }).catch(() => {});
  // Fehlerignorierung bewusst: Sync-Fehler sind nicht kritisch (offline-tolerant)
}

// ── Vollständiger Push+Pull beim App-Start / Vordergrund ─────────────────────

export async function doSync(state: AppState, dispatch: React.Dispatch<Action>): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) return;

  const now = new Date().toISOString();

  // Alle abgeschlossenen lokalen Einträge pushen (idempotent via upsert)
  const timeRows = state.entries
    .filter(e => e.local_id && e.end > 0)
    .map(e => ({
      local_id: e.local_id!,
      user_id: ctx.userId,
      workspace_id: ctx.workspaceId,
      datum: msToDatum(e.start),
      start_zeit: msToZeit(e.start),
      end_zeit: msToZeit(e.end),
      pause_minuten: Math.round(e.pause / 60000),
      notiz: null,
      updated_at: now,
    }));

  if (timeRows.length > 0) {
    await supabase.from("time_entries")
      .upsert(timeRows, { onConflict: "local_id" })
      .catch(() => {});
  }

  // Pull: Server-Daten holen und mit lokalem State mergen
  const pulled = await pullSync().catch(() => null);
  if (pulled) {
    dispatch({ type: "PULL_SYNC_DONE", payload: pulled });
  }
}

// ── Push-Token registrieren ──────────────────────────────────────────────────

export async function registerPushToken(): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) return;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Clocktap",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return;

  try {
    const token = await Notifications.getExpoPushTokenAsync({
      projectId: "d6d0d824-77ff-4451-8df9-b939e6fb0a98",
    });
    await supabase.from("profiles").update({ push_token: token.data }).eq("id", ctx.userId);
  } catch {
    // Push-Token ist nicht kritisch — still ignorieren
  }
}
