import React from "react";
import { View, Text, TouchableOpacity, ScrollView, Image, Modal, ActivityIndicator, Alert, Linking, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import FeedbackModal from "../FeedbackModal";
import HintModal from "../HintModal";
import * as ImagePicker from "expo-image-picker";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as Calendar from "expo-calendar";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Theme } from "../theme";
import { AppState, Action, Settings, ArbeitszeitRegel, ExtraFeiertag, Schicht } from "../store";
import { Icon } from "../Icons";
import { Card, Divider, Input, Toggle, TimeInput, DateInput, useProGate, ProGateModal } from "../Shared";
import { pad, dayKey, MONTHS, getSollStundenForDate, hoursToMs } from "../utils";
import { buildStatistikPdfHtml } from "../pdfTemplate";
import { BUNDESLAENDER } from "../feiertage";
import { supabase } from "../supabase";
import { loadWorkspaceSettings, bulkUploadLocalData } from "../syncService";

interface Props { state: AppState; dispatch: React.Dispatch<Action>; t: Theme; active?: boolean; }

export default function ScreenEinstellungen({ state, dispatch, t, active }: Props) {
  const insets = useSafeAreaInsets();
  const scrollRef = React.useRef<ScrollView>(null);
  const sectionY = React.useRef<Record<string, number>>({});
  React.useEffect(() => { if (active) scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [active]);
  const { settings } = state;
  const set = (key: keyof Settings, val: any) => dispatch({ type: "SET_SETTING", key, val });

  async function pickLogo() {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!req.granted) return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      base64: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0].base64) {
      set("logo", `data:image/jpeg;base64,${result.assets[0].base64}`);
    }
  }

  const apt = settings.arbeitstageProWoche || 5;
  const [wochenStr, setWochenStr] = React.useState(String(Math.round(settings.sollStunden * apt * 100) / 100));
  const [tagStr, setTagStr] = React.useState(String(settings.sollStunden));

  function parseHours(s: string): number | null {
    const cleaned = s.replace(",", ".");
    if (cleaned.endsWith(".")) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
  }

  function onWochenChange(val: string) {
    setWochenStr(val);
    const n = parseHours(val);
    if (n !== null) {
      const daily = Math.round((n / apt) * 100) / 100;
      set("sollStunden", daily);
      setTagStr(String(daily));
    }
  }

  function onTagChange(val: string) {
    setTagStr(val);
    const n = parseHours(val);
    if (n !== null) {
      set("sollStunden", n);
      setWochenStr(String(Math.round(n * apt * 100) / 100));
    }
  }

  function onArbeitstageChange(n: number) {
    set("arbeitstageProWoche", n);
    const soll = parseHours(tagStr);
    if (soll !== null) setWochenStr(String(Math.round(soll * n * 100) / 100));
  }

  const [activeTab, setActiveTab] = React.useState<'einstellungen' | 'arbeitszeit'>('einstellungen');
  const [feedbackVisible, setFeedbackVisible] = React.useState(false);
  const [neuerBegriff, setNeuerBegriff] = React.useState("");
  const [open, setOpen] = React.useState<Record<string, boolean>>({
    darstellung: false, profil: false, abo: false, feedback: false,
    arbeitszeit: false, urlaub: false, stunden: false, kalender: false, features: false, einrichtung: false, export: false, vokabular: false, workspace: false,
  });
  const toggle = (key: string) => {
    const willOpen = !open[key];
    setOpen(o => ({ ...o, [key]: !o[key] }));
    if (willOpen) {
      setTimeout(() => {
        const y = sectionY.current[key];
        if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
      }, 50);
    }
  };
  React.useEffect(() => {
    if (!active) setOpen({ darstellung: false, profil: false, abo: false, feedback: false, arbeitszeit: false, urlaub: false, stunden: false, kalender: false, features: false, einrichtung: false, export: false, vokabular: false, workspace: false });
  }, [active]);

  // ── Workspace Login ─────────────────────────────────────────────────────────
  const [wsLoginVisible, setWsLoginVisible] = React.useState(false);
  const [wsEmail, setWsEmail] = React.useState("");
  const [wsPassword, setWsPassword] = React.useState("");
  const [wsLoading, setWsLoading] = React.useState(false);
  const [wsError, setWsError] = React.useState("");

  async function handleWorkspaceBeitreten() {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wsEmail.trim());
    if (!emailOk) { setWsError("Bitte eine gültige E-Mail-Adresse eingeben."); return; }
    if (wsPassword.trim().length < 6) { setWsError("Passwort muss mindestens 6 Zeichen lang sein."); return; }
    setWsLoading(true);
    setWsError("");
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: wsEmail.trim(), password: wsPassword.trim() });
      if (error) { setWsError("Anmeldung fehlgeschlagen. Bitte Zugangsdaten prüfen."); setWsLoading(false); return; }

      const wsSettings = await loadWorkspaceSettings();
      if (!wsSettings) { setWsError("Kein Workspace gefunden. Bitte den Arbeitgeber kontaktieren."); await supabase.auth.signOut(); setWsLoading(false); return; }

      await bulkUploadLocalData(state, wsSettings.workspaceId);
      dispatch({ type: "APPLY_WORKSPACE_SETTINGS", payload: wsSettings });
      setWsLoginVisible(false);
      setWsEmail("");
      setWsPassword("");
      Alert.alert("Verbunden! ✅", `Du bist jetzt mit dem Workspace von ${wsSettings.firma} verbunden.`);
    } catch {
      setWsError("Verbindungsfehler. Bitte erneut versuchen.");
    }
    setWsLoading(false);
  }

  async function handleWorkspaceAbmelden() {
    Alert.alert(
      "Workspace verlassen?",
      "Deine lokalen Daten bleiben erhalten. Die Verbindung zum Arbeitgeber wird getrennt.",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Abmelden", style: "destructive", onPress: async () => {
            await supabase.auth.signOut();
            dispatch({ type: "SET_SETTINGS_MULTI", payload: { cloudSync: false, isWorkspace: false } });
          }
        },
      ]
    );
  }

  // ── Export ──────────────────────────────────────────────────────────────────
  const isPro = settings.isPro ?? false;
  const proGate = useProGate();
  const [exportModalVisible, setExportModalVisible] = React.useState(false);
  const [bundeslandModalVisible, setBundeslandModalVisible] = React.useState(false);
  const [extraFeiAddDate, setExtraFeiAddDate] = React.useState("");
  const [extraFeiAddName, setExtraFeiAddName] = React.useState("");
  const [extraFeiFormOpen, setExtraFeiFormOpen] = React.useState(false);
  const [exportYear, setExportYear] = React.useState(new Date().getFullYear());
  const [exportSel, setExportSel] = React.useState({
    wochenstunden: true, ueberstunden: true, gearbeitete: true, krankheitstage: true,
  });
  const [exportLoading, setExportLoading] = React.useState(false);
  const currentYear = new Date().getFullYear();
  const [legalModal, setLegalModal] = React.useState<null | "datenschutz" | "nutzung" | "impressum">(null);

  async function doStatistikExport() {
    if (!exportSel.wochenstunden && !exportSel.ueberstunden && !exportSel.gearbeitete && !exportSel.krankheitstage) {
      Alert.alert("Nichts ausgewählt", "Bitte mindestens eine Statistik auswählen.");
      return;
    }
    setExportLoading(true);
    try {
      const { entries, settings, kranktage = [], arbeitszeitRegeln = [], stundenAbgebaut = [] } = state;

      let wochenstunden: { label: string; value: number }[] | undefined;
      if (exportSel.wochenstunden) {
        wochenstunden = Array.from({ length: 12 }, (_, month) => {
          const ms = entries
            .filter(e => { const d = new Date(e.start); return d.getFullYear() === exportYear && d.getMonth() === month; })
            .reduce((sum, e) => sum + e.net, 0);
          return { label: String(month), value: Math.round(ms / 36000) / 100 };
        });
      }

      let ueberstunden: { label: string; value: number }[] | undefined;
      if (exportSel.ueberstunden) {
        const now = new Date();
        const abzugH = settings.monatlicheAbzugStunden ?? 0;
        const abzugModus = settings.monatlicheAbzugModus ?? "alle";
        const abzugMonate = settings.monatlicheAbzugMonate ?? [];
        const apt = settings.arbeitstageProWoche || 5;
        ueberstunden = Array.from({ length: 12 }, (_, month) => {
          const isFuture = exportYear > now.getFullYear() || (exportYear === now.getFullYear() && month > now.getMonth());
          if (isFuture) return { label: String(month), value: 0 };
          const actualMs = entries
            .filter(e => { const d = new Date(e.start); return d.getFullYear() === exportYear && d.getMonth() === month; })
            .reduce((sum, e) => sum + e.net, 0);
          const lastDay = (exportYear === now.getFullYear() && month === now.getMonth()) ? now.getDate() : new Date(exportYear, month + 1, 0).getDate();
          let expectedMs = 0;
          for (let d = 1; d <= lastDay; d++) {
            const ts = new Date(exportYear, month, d).getTime();
            const wd = new Date(exportYear, month, d).getDay();
            if (wd !== 0 && wd !== 6) expectedMs += hoursToMs(getSollStundenForDate(ts, settings.sollStunden, arbeitszeitRegeln, apt));
          }
          const monthNum = month + 1;
          const abzugAktiv = abzugModus === "alle" || (abzugModus === "monate" && abzugMonate.includes(monthNum));
          const abzugThisMonth = abzugH > 0 && abzugAktiv ? abzugH : 0;
          const abgebautThisMonth = stundenAbgebaut
            .filter(e => { const d = new Date(e.date + "T12:00:00"); return d.getFullYear() === exportYear && d.getMonth() === month; })
            .reduce((s, e) => s + e.stunden, 0);
          const overtime = actualMs > 0 ? (actualMs - expectedMs) / 3600000 - abzugThisMonth - abgebautThisMonth : 0;
          return { label: String(month), value: Math.round(overtime * 100) / 100 };
        });
      }

      let gearbeitateTage: { label: string; value: number }[] | undefined;
      if (exportSel.gearbeitete) {
        gearbeitateTage = Array.from({ length: 12 }, (_, month) => {
          const days = new Set(
            entries
              .filter(e => { const d = new Date(e.start); return d.getFullYear() === exportYear && d.getMonth() === month; })
              .map(e => dayKey(e.start))
          ).size;
          return { label: String(month), value: days };
        });
      }

      let krankData: { label: string; value: number }[] | undefined;
      if (exportSel.krankheitstage) {
        krankData = Array.from({ length: 12 }, (_, month) => ({
          label: String(month),
          value: (kranktage as string[]).filter(k => {
            const [y, m] = k.split("-").map(Number);
            return y === exportYear && m === month;
          }).length,
        }));
      }

      const html = buildStatistikPdfHtml({
        year: exportYear,
        name: settings.name,
        firma: settings.firma,
        logo: settings.logo,
        wochenstunden,
        ueberstunden,
        gearbeitateTage,
        krankheitstage: krankData,
      });
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: "Jahresstatistik teilen" });
      }
      setExportModalVisible(false);
    } finally {
      setExportLoading(false);
    }
  }

  // ── Schichtplan → nativer Kalender ─────────────────────────────────────────
  async function exportSchichtplanToCalendar() {
    const { schichtplan } = state;
    if (!schichtplan || schichtplan.length === 0) {
      Alert.alert("Kein Schichtplan", "Es sind keine Schichten vorhanden."); return;
    }
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Berechtigung fehlt", "Bitte Kalender-Zugriff in den Einstellungen erlauben."); return;
    }
    try {
      // Clocktap-Kalender suchen oder erstellen
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      let calId = calendars.find(c => c.title === "Clocktap")?.id;
      if (!calId) {
        calId = await Calendar.createCalendarAsync({
          title: "Clocktap",
          color: "#007AFF",
          entityType: Calendar.EntityTypes.EVENT,
          sourceId: calendars.find(c => c.source?.isLocalAccount)?.source?.id,
          source: { isLocalAccount: true, name: "Clocktap", type: "" },
          name: "clocktap",
          ownerAccount: "personal",
          accessLevel: Calendar.CalendarAccessLevel.OWNER,
        });
      }
      // Alle bestehenden Clocktap-Events löschen (sauberer Sync)
      const now = new Date();
      const far = new Date(now.getFullYear() + 2, 0, 1);
      const past = new Date(now.getFullYear() - 1, 0, 1);
      const existing = await Calendar.getEventsAsync([calId], past, far);
      await Promise.all(existing.map(e => Calendar.deleteEventAsync(e.id)));
      // Neue Einträge schreiben
      for (const s of schichtplan) {
        const [y, m, d] = s.date.split("-").map(Number);
        const [sh, sm] = s.start.split(":").map(Number);
        const [eh, em] = s.end.split(":").map(Number);
        const startDate = new Date(y, m - 1, d, sh, sm);
        const endDate = new Date(y, m - 1, d, eh, em);
        if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1);
        await Calendar.createEventAsync(calId, {
          title: `Schicht ${s.start}–${s.end}`,
          startDate, endDate, timeZone: "Europe/Berlin",
        });
      }
      Alert.alert("Fertig", `${schichtplan.length} Schichten wurden in den Kalender "Clocktap" exportiert.`);
    } catch (e) {
      Alert.alert("Fehler", "Kalender-Export fehlgeschlagen.");
    }
  }

  // ── ICS-Datei → Schichtplan ─────────────────────────────────────────────────
  async function importIcsToSchichtplan() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["text/calendar", "application/octet-stream", "*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const uri = result.assets[0].uri;
      const raw = await FileSystem.readAsStringAsync(uri);
      // ICS parsen — VEVENT Blöcke extrahieren
      const events = raw.split("BEGIN:VEVENT").slice(1);
      const newSchichten: Schicht[] = [];
      let skipped = 0;
      for (const ev of events) {
        const dtStart = ev.match(/DTSTART[^:]*:(\d{8}T\d{6})/)?.[1] || ev.match(/DTSTART[^:]*:(\d{8})/)?.[1];
        const dtEnd   = ev.match(/DTEND[^:]*:(\d{8}T\d{6})/)?.[1]   || ev.match(/DTEND[^:]*:(\d{8})/)?.[1];
        if (!dtStart) { skipped++; continue; }
        const parseDate = (s: string) => {
          const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
          const h = s.length >= 13 ? s.slice(9, 11) : "00";
          const m = s.length >= 15 ? s.slice(11, 13) : "00";
          return { date: `${y}-${mo}-${d}`, time: `${h}:${m}` };
        };
        const start = parseDate(dtStart);
        const end   = dtEnd ? parseDate(dtEnd) : { date: start.date, time: "00:00" };
        if (start.time === "00:00" && end.time === "00:00") { skipped++; continue; } // Ganztagesevents überspringen
        newSchichten.push({ id: Date.now() + newSchichten.length, date: start.date, start: start.time, end: end.time });
      }
      if (newSchichten.length === 0) {
        Alert.alert("Keine Schichten gefunden", "Die Datei enthält keine verwertbaren Zeiteinträge."); return;
      }
      Alert.alert(
        "Schichtplan importieren",
        `${newSchichten.length} Schichten gefunden${skipped > 0 ? `, ${skipped} übersprungen` : ""}.\nBestehenden Schichtplan ersetzen oder zusammenführen?`,
        [
          { text: "Abbrechen", style: "cancel" },
          { text: "Zusammenführen", onPress: () => dispatch({ type: "MERGE_SCHICHTPLAN", payload: newSchichten }) },
          { text: "Ersetzen", style: "destructive", onPress: () => dispatch({ type: "SET_SCHICHTPLAN", payload: newSchichten }) },
        ]
      );
    } catch {
      Alert.alert("Fehler", "Datei konnte nicht gelesen werden.");
    }
  }

  // ── JSON Backup Export ──────────────────────────────────────────────────────
  async function exportBackup() {
    try {
      const json = JSON.stringify(state, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? "";
      const path = `${dir}clocktap_backup_${date}.json`;
      await FileSystem.writeAsStringAsync(path, json, { encoding: "utf8" });
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) { Alert.alert("Fehler", "Teilen wird auf diesem Gerät nicht unterstützt."); return; }
      await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Backup speichern oder teilen" });
    } catch (e: any) {
      Alert.alert("Fehler", e?.message ?? "Backup konnte nicht erstellt werden.");
    }
  }

  // ── JSON Backup Import ──────────────────────────────────────────────────────
  async function importBackup() {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ["application/json", "*/*"], copyToCacheDirectory: true });
      if (result.canceled || !result.assets?.[0]) return;
      const raw = await FileSystem.readAsStringAsync(result.assets[0].uri);
      const parsed = JSON.parse(raw);
      // Minimale Validierung
      if (!parsed.settings || !Array.isArray(parsed.entries)) {
        Alert.alert("Ungültige Datei", "Die gewählte Datei ist kein gültiges Clocktap-Backup."); return;
      }
      Alert.alert(
        "Backup einspielen?",
        "Alle aktuellen Daten werden durch das Backup ersetzt. Dieser Vorgang kann nicht rückgängig gemacht werden.",
        [
          { text: "Abbrechen", style: "cancel" },
          { text: "Wiederherstellen", style: "destructive", onPress: () => dispatch({ type: "LOAD", payload: parsed }) },
        ]
      );
    } catch {
      Alert.alert("Fehler", "Backup-Datei konnte nicht gelesen werden.");
    }
  }

  function SectionHeader({ label, skey, emoji }: { label: string; skey: string; emoji: string }) {
    const isOpen = open[skey];
    return (
      <TouchableOpacity
        onPress={() => toggle(skey)}
        activeOpacity={0.7}
        onLayout={e => { sectionY.current[skey] = e.nativeEvent.layout.y; }}
        style={{
          flexDirection: "row", justifyContent: "space-between", alignItems: "center",
          backgroundColor: t.bg3, borderRadius: 12,
          paddingHorizontal: 16, paddingVertical: 13, marginTop: 10,
          marginBottom: isOpen ? 6 : 0,
          borderWidth: 1, borderColor: t.border,
        }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ fontSize: 18 }}>{emoji}</Text>
          <Text style={{ fontSize: 15, fontWeight: "600", color: t.text }}>{label}</Text>
        </View>
        <Icon name={isOpen ? "chevron-up" : "chevron-down"} size={16} color={t.text3} />
      </TouchableOpacity>
    );
  }

  const [showRegelForm, setShowRegelForm] = React.useState(false);
  const [regelVon, setRegelVon] = React.useState("");
  const [regelBis, setRegelBis] = React.useState("");
  const [regelWochen, setRegelWochen] = React.useState("");

  function parseRuleDate(s: string): string | null {
    const parts = s.trim().split(".");
    if (parts.length !== 3) return null;
    const [d, m, y] = parts.map(Number);
    if (isNaN(d) || isNaN(m) || isNaN(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const year = y < 100 ? 2000 + y : y;
    return `${year}-${pad(m)}-${pad(d)}`;
  }

  function formatRuleDate(s: string): string {
    const p = s.split("-");
    return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : s;
  }

  function addRegel() {
    const von = parseRuleDate(regelVon);
    const bis = parseRuleDate(regelBis);
    const w = parseHours(regelWochen);
    if (!von || !bis || !w) return;
    dispatch({ type: "ADD_AZ_REGEL", payload: { id: Date.now(), von, bis, wochenStunden: w } as ArbeitszeitRegel });
    setRegelVon(""); setRegelBis(""); setRegelWochen(""); setShowRegelForm(false);
  }

  function Stepper({ onDec, onInc, label }: { onDec: () => void; onInc: () => void; label: string }) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <TouchableOpacity onPress={onDec} style={{ backgroundColor: t.bg4, borderRadius: 16, minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
          <Text style={{ color: t.text, fontSize: 18 }} allowFontScaling={false}>−</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: "600", color: t.text, minWidth: 44, textAlign: "center" }}>{label}</Text>
        <TouchableOpacity onPress={onInc} style={{ backgroundColor: t.bg4, borderRadius: 16, minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
          <Text style={{ color: t.text, fontSize: 18 }} allowFontScaling={false}>+</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isWorkspace = settings.cloudSync === true;
  const tabLabel = isWorkspace ? "Mein Vertrag" : "Meine Arbeitszeit";

  function VertragItem({ emoji, label, value, locked }: { emoji: string; label: string; value: string; locked?: boolean }) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
          <Text style={{ fontSize: 16 }}>{emoji}</Text>
          <Text style={{ fontSize: 14, color: t.text2 }}>{label}</Text>
          {locked && <Text style={{ fontSize: 11, color: t.text4 }}>🔒</Text>}
        </View>
        <Text style={{ fontSize: 14, fontWeight: "600", color: t.text }}>{value}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <HintModal storageKey="hint_einstellungen" t={t} steps={[
        { emoji: "👤", title: "Profil & Logo", description: "Trage deinen Namen, Firmennamen und Logo ein — sie erscheinen automatisch in deinen PDF-Berichten." },
        { emoji: "⏱️", title: "Arbeitszeit & Pausen", description: "Stelle deine Wochen- und Tagesstunden sowie Pausenregelungen ein. Diese Werte sind die Basis für deine Überstundenberechnung." },
        { emoji: "💼", title: "Stunden & Abzüge", description: "Trage mitgebrachte Stunden vom Jobstart und den Betriebspuffer ein. Unter 'Monatlicher Abzug' kannst du Stunden eintragen die dein Arbeitgeber monatlich vom Konto abzieht (z.B. pauschal 10 Std/Monat)." },
        { emoji: "🏖️", title: "Urlaub", description: "Trage deine jährlichen Urlaubstage, Resturlaub aus dem Vorjahr und bereits genommene Urlaubstage ein." },
        { emoji: "⚡", title: "Features", description: "Aktiviere oder deaktiviere Schichtarbeit und Regiebericht je nach deinem Arbeitsbereich." },
        { emoji: "📤", title: "Export & Datensicherung", description: "Exportiere Statistiken als PDF, synchronisiere deinen Kalender oder sichere deine gesamten App-Daten." },
      ]} />

      {/* Tab-Bar */}
      <View style={{ flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 8 }}>
        {(["einstellungen", "arbeitszeit"] as const).map(tab => {
          const label = tab === "einstellungen" ? "Einstellungen" : tabLabel;
          const active = activeTab === tab;
          return (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={{
                flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: "center",
                backgroundColor: active ? t.green + "1a" : t.bg3,
                borderWidth: 1,
                borderColor: active ? t.green + "55" : t.border,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: active ? "700" : "500", color: active ? t.green : t.text2 }}>
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Tab: Meine Arbeitszeit / Mein Vertrag ─────────────────────────── */}
      {activeTab === "arbeitszeit" && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
          {isWorkspace && (
            <View style={{ backgroundColor: t.blue + "12", borderRadius: 12, padding: 12, marginBottom: 14, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: t.blue + "30" }}>
              <Text style={{ fontSize: 13 }}>🏢</Text>
              <Text style={{ fontSize: 12, color: t.text3, flex: 1 }}>🔒 Felder werden vom Arbeitgeber festgelegt und können nicht verändert werden.</Text>
            </View>
          )}
          <View style={{ backgroundColor: t.bg3, borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontSize: 12, color: t.text4, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, fontWeight: "600" }}>Arbeitszeit</Text>
            <VertragItem emoji="⏱" label="Wochenstunden" value={`${Math.round(settings.sollStunden * apt * 100) / 100} h`} locked={isWorkspace} />
            <VertragItem emoji="📅" label="Arbeitstage / Woche" value={`${apt} Tage`} locked={isWorkspace} />
            <VertragItem emoji="☕" label="Pause ab" value={`${settings.pauseNachStunden} h → ${settings.pauseMinuten} min`} locked={isWorkspace} />
            {settings.bundesland ? (
              <VertragItem emoji="📍" label="Bundesland" value={settings.bundesland} locked={isWorkspace} />
            ) : null}
          </View>
          <View style={{ backgroundColor: t.bg3, borderRadius: 14, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontSize: 12, color: t.text4, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, fontWeight: "600" }}>Urlaub & Konto</Text>
            <VertragItem emoji="🏖" label="Urlaubstage / Jahr" value={`${settings.urlaubstageGesamt} Tage`} locked={isWorkspace} />
            <VertragItem emoji="➕" label="Resturlaub Vorjahr" value={`${settings.urlaubVorjahr} Tage`} locked={isWorkspace} />
            <VertragItem emoji="⚖️" label="Karenz / Monat" value={settings.karenzProMonat > 0 ? `${settings.karenzProMonat} h` : "—"} locked={isWorkspace} />
            <VertragItem emoji="💰" label="Startsaldo" value={settings.stundenKontoOffset !== 0 ? `${settings.stundenKontoOffset > 0 ? "+" : ""}${settings.stundenKontoOffset} h` : "—"} locked={isWorkspace} />
            {settings.monatlicheAbzugStunden > 0 && (
              <VertragItem emoji="📉" label="Monatl. Abzug" value={`${settings.monatlicheAbzugStunden} h`} locked={isWorkspace} />
            )}
          </View>
          {state.arbeitszeitRegeln && state.arbeitszeitRegeln.length > 0 && (
            <View style={{ backgroundColor: t.bg3, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: t.border }}>
              <Text style={{ fontSize: 12, color: t.text4, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, fontWeight: "600" }}>Arbeitszeitregeln</Text>
              {state.arbeitszeitRegeln.map((r, i) => (
                <View key={r.id ?? i} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9, borderBottomWidth: i < state.arbeitszeitRegeln.length - 1 ? 1 : 0, borderBottomColor: t.border }}>
                  <Text style={{ fontSize: 13, color: t.text2 }}>
                    {r.von ? r.von.slice(5).split("-").reverse().join(".") : "?"} – {r.bis ? r.bis.slice(5).split("-").reverse().join(".") : "?"}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {isWorkspace && <Text style={{ fontSize: 11, color: t.text4 }}>🔒</Text>}
                    <Text style={{ fontSize: 14, fontWeight: "600", color: t.text }}>{r.wochenStunden} h/W</Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {/* ── Tab: Einstellungen (bestehender Inhalt) ─────────────────────── */}
      {activeTab === "einstellungen" && (
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 20 }}>

      {/* Premium Card — immer sichtbar */}
      {isWorkspace ? (
        <View style={{ backgroundColor: t.blue + "14", borderRadius: 14, padding: 16, marginBottom: 16, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: t.blue + "40" }}>
          <Text style={{ fontSize: 26 }}>🏢</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: t.blue }}>Workspace-Mitglied</Text>
            <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>{settings.firma || "Workspace"} · Zugang vom Arbeitgeber</Text>
          </View>
        </View>
      ) : isPro ? (
        <View style={{ backgroundColor: t.green + "18", borderRadius: 14, padding: 16, marginBottom: 16, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: t.green + "44" }}>
          <Text style={{ fontSize: 26 }}>⭐</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: t.green }}>Clocktap Pro aktiv</Text>
            <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>KI-Berichte · Statistik · Export · Backup</Text>
          </View>
        </View>
      ) : (
        <View style={{ backgroundColor: t.blue + "12", borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: t.blue + "33" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <Text style={{ fontSize: 22 }}>⭐</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: t.text }}>FREE PLAN</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 1 }}>KI-Berichte · Statistik · Export · Backup</Text>
            </View>
          </View>
          <TouchableOpacity
            style={{ backgroundColor: t.blue, borderRadius: 10, paddingVertical: 12, alignItems: "center" }}
            onPress={() => Alert.alert("Bald verfügbar", "Das Abo wird in Kürze verfügbar sein.")}>
            <Text style={{ fontSize: 14, fontWeight: "700", color: "#fff" }}>Upgrade – 3,99 € / Monat</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Darstellung */}
      <SectionHeader label="Darstellung" skey="darstellung" emoji="🌙" />
      {open.darstellung && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, marginRight: 12 }}>
              <Icon name={settings.darkMode ? "moon" : "sun"} size={18} color={t.text2} />
              <Text style={{ fontSize: 15, color: t.text }}>Dark Mode</Text>
            </View>
            <Toggle value={settings.darkMode} onChange={v => set("darkMode", v)} t={t} />
          </View>
        </Card>
      )}

      {/* Profil */}
      <SectionHeader label="Profil" skey="profil" emoji="👤" />
      {open.profil && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          {(["name", "firma"] as const).map((key, i) => (
            <View key={key}>
              {i > 0 && <Divider t={t} />}
              <View style={{ paddingVertical: 12 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>{key === "name" ? "Name" : "Firma / Betrieb"}</Text>
                <Input value={settings[key] || ""} onChange={v => set(key, v)} placeholder={key === "name" ? "Name" : "Firma / Betrieb"} t={t} />
              </View>
            </View>
          ))}
          <Divider t={t} />
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 8 }}>Firmenlogo</Text>

            {/* PDF-Vorschau */}
            {settings.logo ? (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 11, color: t.text4, marginBottom: 6 }}>Vorschau in der PDF</Text>
                <View style={{
                  backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e0e0e0",
                  padding: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                }}>
                  <Image source={{ uri: settings.logo }} style={{ height: 60, width: 220, resizeMode: "contain" }} />
                  <Text style={{ fontSize: 13, fontWeight: "700", color: "#1a1a1a" }} numberOfLines={1}>
                    {settings.firma || "Firmenname"}
                  </Text>
                </View>
              </View>
            ) : null}

            <TouchableOpacity onPress={pickLogo} style={{
              height: 52, borderRadius: 10, borderWidth: 1, borderStyle: "dashed",
              borderColor: t.text4, backgroundColor: t.bg4, alignItems: "center",
              justifyContent: "center", flexDirection: "row", gap: 8,
            }}>
              <Icon name="image" size={18} color={t.text4} />
              <Text style={{ fontSize: 13, color: t.text4 }}>{settings.logo ? "Logo austauschen" : "Logo hochladen"}</Text>
            </TouchableOpacity>

            {settings.logo ? (
              <TouchableOpacity onPress={() => set("logo", "")} style={{ marginTop: 6, alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Icon name="x" size={13} color={t.red} />
                <Text style={{ fontSize: 12, color: t.red }}>Logo entfernen</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Card>
      )}

      {/* Abo */}
      <SectionHeader label="Abo" skey="abo" emoji="⭐" />
      {open.abo && (
        <Card t={t} style={{ padding: 16 }}>
          {isWorkspace ? (
            <>
              {/* Workspace-Status */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <View>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>Im Workspace</Text>
                  <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>{settings.firma || "Workspace"}</Text>
                </View>
                <View style={{ backgroundColor: t.blue + "20", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, color: t.blue, fontWeight: "600" }}>WORKSPACE</Text>
                </View>
              </View>
              <Divider t={t} />
              <Text style={{ fontSize: 13, color: t.text2, marginTop: 14, lineHeight: 20 }}>
                Dein Zugang wird über den Workspace deines Arbeitgebers bereitgestellt.
              </Text>
              <View style={{ backgroundColor: t.orange + "15", borderRadius: 10, padding: 12, marginTop: 12, borderWidth: 1, borderColor: t.orange + "40" }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: t.orange, marginBottom: 4 }}>Hinweis: Google Play Abo</Text>
                <Text style={{ fontSize: 12, color: t.text2, lineHeight: 18 }}>
                  Wenn du ein aktives Clocktap-Abo über Google Play hast, kannst du es jetzt kündigen – dein Zugang bleibt über den Workspace erhalten.
                </Text>
              </View>
              <TouchableOpacity
                style={{ marginTop: 14, backgroundColor: t.bg3, borderRadius: 12, paddingVertical: 14, alignItems: "center" }}
                onPress={() => Linking.openURL("https://play.google.com/store/account/subscriptions")}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: t.text2 }}>Google Play Abos verwalten</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              {/* Aktueller Status */}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <View>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>Kostenlose Version</Text>
                  <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Clocktap Free</Text>
                </View>
                <View style={{ backgroundColor: t.bg3, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 }}>
                  <Text style={{ fontSize: 12, color: t.text3, fontWeight: "600" }}>FREE</Text>
                </View>
              </View>
              <Divider t={t} />
              {/* Pro Features */}
              <Text style={{ fontSize: 13, color: t.text3, marginTop: 14, marginBottom: 10, fontWeight: "600", letterSpacing: 0.5 }}>PRO ENTHÄLT</Text>
              {[
                { icon: "🤖", label: "KI Regiebericht (unbegrenzt)" },
                { icon: "📸", label: "Schichtplan Foto-Import" },
                { icon: "📊", label: "Erweiterte Statistiken & Export" },
                { icon: "📅", label: "Kalender-Sync & Import" },
                { icon: "☁️", label: "Datensicherung & Backup" },
                { icon: "🔔", label: "Erinnerungen & Benachrichtigungen", soon: true },
              ].map((f, i) => (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7 }}>
                  <Text style={{ fontSize: 16 }}>{f.icon}</Text>
                  <Text style={{ fontSize: 14, color: t.text }}>{f.label}</Text>
                  {f.soon && <Text style={{ fontSize: 11, color: t.text4, marginLeft: 2 }}>demnächst</Text>}
                </View>
              ))}
              <Divider t={t} />
              {/* Preis */}
              <TouchableOpacity style={{
                marginTop: 14, backgroundColor: t.blue, borderRadius: 12, paddingVertical: 14, alignItems: "center",
              }} onPress={() => Alert.alert("Bald verfügbar", "Das Abo wird in Kürze verfügbar sein.")}>
                <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>3,99 € / Monat</Text>
                <Text style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>monatlich kündbar</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ marginTop: 12, alignItems: "center", paddingVertical: 6 }}
                onPress={() => Alert.alert("Abo wiederherstellen", "Diese Funktion wird mit der Abo-Umsetzung aktiviert.")}>
                <Text style={{ fontSize: 13, color: t.text3 }}>Abo wiederherstellen</Text>
              </TouchableOpacity>
            </>
          )}
        </Card>
      )}

      {/* Workspace */}
      {(() => {
        const isWorkspace = settings.cloudSync === true;
        return (
      <>
      <SectionHeader label="Workspace" skey="workspace" emoji="🏢" />
      {open.workspace && (
        <Card t={t} style={{ padding: 16 }}>
          {isWorkspace ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.green + "22", alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 20 }}>🏢</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: t.text }}>{settings.firma || "Workspace"}</Text>
                  <Text style={{ fontSize: 12, color: t.green, marginTop: 2 }}>● Verbunden</Text>
                </View>
              </View>
              <Text style={{ fontSize: 12, color: t.text3, lineHeight: 17, marginBottom: 16 }}>
                Deine Arbeitszeiten werden mit dem Arbeitgeber synchronisiert. Vertragliche Einstellungen werden vom Arbeitgeber verwaltet.
              </Text>
              <TouchableOpacity
                onPress={handleWorkspaceAbmelden}
                style={{ backgroundColor: t.bg3, borderRadius: 10, paddingVertical: 11, alignItems: "center" }}>
                <Text style={{ fontSize: 14, color: t.red, fontWeight: "600" }}>Workspace verlassen</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 14, color: t.text, fontWeight: "600", marginBottom: 6 }}>Einem Workspace beitreten</Text>
              <Text style={{ fontSize: 12, color: t.text3, lineHeight: 17, marginBottom: 16 }}>
                Du hast eine Einladung von deinem Arbeitgeber erhalten? Melde dich hier mit deinen Zugangsdaten an.
              </Text>
              <TouchableOpacity
                onPress={() => { setWsError(""); setWsLoginVisible(true); }}
                style={{ backgroundColor: t.blue, borderRadius: 10, paddingVertical: 12, alignItems: "center" }}>
                <Text style={{ fontSize: 14, color: "#fff", fontWeight: "700" }}>🔗 Anmelden & verbinden</Text>
              </TouchableOpacity>
            </>
          )}
        </Card>
      )}

      {/* Workspace Login Modal */}
      <Modal visible={wsLoginVisible} transparent animationType="slide" onRequestClose={() => { setWsLoginVisible(false); setWsPassword(""); setWsError(""); }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
            <View style={{ backgroundColor: t.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 24 + insets.bottom }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: t.text }}>Workspace beitreten</Text>
              <TouchableOpacity onPress={() => { setWsLoginVisible(false); setWsPassword(""); setWsError(""); }}>
                <Text style={{ fontSize: 22, color: t.text3, lineHeight: 26 }}>×</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 18, lineHeight: 17 }}>
              Verwende die E-Mail und das Passwort aus der Einladung deines Arbeitgebers.
            </Text>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>E-Mail</Text>
            <TextInput
              value={wsEmail}
              onChangeText={setWsEmail}
              placeholder="deine@email.de"
              placeholderTextColor={t.text4}
              keyboardType="email-address"
              autoCapitalize="none"
              style={{ backgroundColor: t.bg3, borderRadius: 10, padding: 12, color: t.text, fontSize: 14, marginBottom: 14 }}
            />
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Passwort</Text>
            <TextInput
              value={wsPassword}
              onChangeText={setWsPassword}
              placeholder="Passwort"
              placeholderTextColor={t.text4}
              secureTextEntry
              style={{ backgroundColor: t.bg3, borderRadius: 10, padding: 12, color: t.text, fontSize: 14, marginBottom: wsError ? 10 : 20 }}
            />
            {wsError ? (
              <Text style={{ fontSize: 12, color: t.red, marginBottom: 14 }}>{wsError}</Text>
            ) : null}
            <TouchableOpacity
              onPress={() => Linking.openURL("https://clocktap-web.vercel.app/login/passwort-vergessen")}
              style={{ alignSelf: "flex-end", marginBottom: 16, marginTop: wsError ? 0 : 4 }}>
              <Text style={{ fontSize: 12, color: t.blue }}>Passwort vergessen?</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleWorkspaceBeitreten}
              disabled={wsLoading}
              style={{ backgroundColor: wsLoading ? t.bg3 : t.blue, borderRadius: 12, paddingVertical: 14, alignItems: "center" }}>
              {wsLoading
                ? <ActivityIndicator color={t.text3} />
                : <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>Verbinden</Text>}
            </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      </>
        );
      })()}

      {/* Fachbegriffe / Vokabular */}
      {settings.hatRegiebericht && (
        <>
          <SectionHeader label="Fachbegriffe" skey="vokabular" emoji="📚" />
          {open.vokabular && (
            <Card t={t} style={{ marginBottom: 4 }}>
              <Text style={{ fontSize: 12, color: t.text3, marginBottom: 12, lineHeight: 17 }}>
                Diese Begriffe werden der KI mitgegeben um Spracherkennungsfehler zu korrigieren. Die App lernt automatisch aus gespeicherten Berichten.
              </Text>
              {/* Neuen Begriff hinzufügen */}
              <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                <TextInput
                  value={neuerBegriff}
                  onChangeText={setNeuerBegriff}
                  placeholder="Begriff hinzufügen…"
                  placeholderTextColor={t.text4}
                  style={{ flex: 1, backgroundColor: t.bg4, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: t.text, fontSize: 14, borderWidth: 1, borderColor: t.border }}
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    const w = neuerBegriff.trim();
                    if (w.length >= 2) { dispatch({ type: "LEARN_VOKABULAR", payload: [w] }); setNeuerBegriff(""); }
                  }}
                />
                <TouchableOpacity
                  onPress={() => {
                    const w = neuerBegriff.trim();
                    if (w.length >= 2) { dispatch({ type: "LEARN_VOKABULAR", payload: [w] }); setNeuerBegriff(""); }
                  }}
                  style={{ backgroundColor: t.blue, borderRadius: 10, paddingHorizontal: 14, justifyContent: "center" }}>
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>+</Text>
                </TouchableOpacity>
              </View>
              {/* Liste */}
              {(settings.regieVokabular || []).length === 0 ? (
                <Text style={{ fontSize: 13, color: t.text4, textAlign: "center", paddingVertical: 8 }}>
                  Noch keine Begriffe — werden aus Berichten automatisch gelernt.
                </Text>
              ) : (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {(settings.regieVokabular || []).map(term => (
                    <TouchableOpacity
                      key={term}
                      onPress={() => dispatch({ type: "DEL_VOKABULAR_TERM", payload: term })}
                      style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: t.bg4, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: t.border }}>
                      <Text style={{ fontSize: 13, color: t.text }}>{term}</Text>
                      <Text style={{ fontSize: 11, color: t.text4 }}>✕</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </Card>
          )}
        </>
      )}

      {/* Feedback */}
      <SectionHeader label="Feedback" skey="feedback" emoji="💬" />
      {open.feedback && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <TouchableOpacity
            onPress={() => setFeedbackVisible(true)}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 16, gap: 14 }}
          >
            <View style={{
              width: 38, height: 38, borderRadius: 10, backgroundColor: t.blue + "22",
              alignItems: "center", justifyContent: "center",
            }}>
              <Text style={{ fontSize: 18 }}>💬</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: t.text }}>Feedback senden</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Fehler melden, Features wünschen</Text>
            </View>
            <Text style={{ fontSize: 18, color: t.text3 }}>›</Text>
          </TouchableOpacity>
          <Divider t={t} />
          <TouchableOpacity
            onPress={() => Linking.openURL("market://details?id=com.clocktap.app").catch(() =>
              Linking.openURL("https://play.google.com/store/apps/details?id=com.clocktap.app")
            )}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 16, gap: 14 }}
          >
            <View style={{
              width: 38, height: 38, borderRadius: 10, backgroundColor: t.green + "22",
              alignItems: "center", justifyContent: "center",
            }}>
              <Text style={{ fontSize: 18 }}>⭐</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: t.text }}>App bewerten</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Im Play Store bewerten</Text>
            </View>
            <Text style={{ fontSize: 18, color: t.text3 }}>›</Text>
          </TouchableOpacity>
        </Card>
      )}

      <FeedbackModal visible={feedbackVisible} onClose={() => setFeedbackVisible(false)} t={t} />

      {!isWorkspace && (<>
      {/* Arbeitszeit */}
      <SectionHeader label="Arbeitszeit" skey="arbeitszeit" emoji="⏱️" />
      {open.arbeitszeit && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 15, color: t.text, marginBottom: 10 }}>Arbeitszeit</Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Wochenstunden</Text>
                <Input value={wochenStr} onChange={onWochenChange} placeholder="z.B. 40.2" t={t} keyboardType="decimal-pad" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Stunden / Tag</Text>
                <Input value={tagStr} onChange={onTagChange} placeholder="z.B. 8" t={t} keyboardType="decimal-pad" />
              </View>
            </View>
            <Text style={{ fontSize: 11, color: t.text4, marginTop: 6 }}>Basis für Überstundenrechnung · Werte sind verknüpft</Text>
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 15, color: t.text, marginBottom: 4 }}>Arbeitstage pro Woche</Text>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 10 }}>Wird für die Berechnung des Tages-Solls genutzt</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              {[1, 2, 3, 4, 5, 6, 7].map(n => (
                <TouchableOpacity key={n} onPress={() => onArbeitstageChange(n)} style={{
                  flex: 1, paddingVertical: 9, borderRadius: 10,
                  backgroundColor: (settings.arbeitstageProWoche || 5) === n ? t.text : t.bg4,
                  alignItems: "center",
                }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: (settings.arbeitstageProWoche || 5) === n ? t.bg : t.text3 }}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 15, color: t.text, marginBottom: 8 }}>Automatische Pause</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {([[15, "15 Min."], [30, "30 Min."], [45, "45 Min."]] as [number, string][]).map(([val, label]) => (
                <TouchableOpacity key={val} onPress={() => set("pauseMinuten", val)} style={{
                  flex: 1, paddingVertical: 9, borderRadius: 10,
                  backgroundColor: settings.pauseMinuten === val ? t.text : t.bg4,
                  alignItems: "center",
                }}>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: settings.pauseMinuten === val ? t.bg : t.text2 }}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={{ fontSize: 12, color: t.text3, marginTop: 8 }}>Pause wird automatisch nach {settings.pauseNachStunden}h abgezogen</Text>
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ fontSize: 15, color: t.text }}>Feste Pause</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>z.B. 15 Min. um 09:00</Text>
              </View>
              <Toggle value={!!(settings.fixPauseMinuten && settings.fixPauseZeit)} onChange={v => { if (!v) { set("fixPauseMinuten", 0); set("fixPauseZeit", ""); } else { set("fixPauseMinuten", 15); } }} t={t} />
            </View>
            {!!(settings.fixPauseMinuten || settings.fixPauseZeit) && (
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Uhrzeit</Text>
                  <TimeInput value={settings.fixPauseZeit || ""} onChange={v => set("fixPauseZeit", v)} t={t} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Dauer (Min)</Text>
                  <Stepper
                    onDec={() => set("fixPauseMinuten", Math.max(5, (settings.fixPauseMinuten || 15) - 5))}
                    onInc={() => set("fixPauseMinuten", (settings.fixPauseMinuten || 15) + 5)}
                    label={`${settings.fixPauseMinuten || 15} Min.`}
                  />
                </View>
              </View>
            )}
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Karenzzeit / Monat</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Betriebsinteressenzeit</Text>
            </View>
            <Stepper
              onDec={() => set("karenzProMonat", Math.max(0, settings.karenzProMonat - 0.5))}
              onInc={() => set("karenzProMonat", settings.karenzProMonat + 0.5)}
              label={`${settings.karenzProMonat}h`}
            />
          </View>
          <Divider t={t} />
          {/* Bau Winterzeit */}
          <View style={{ paddingVertical: 12 }}>
            <Text style={{ fontSize: 15, color: t.text, marginBottom: 2 }}>Bau Winterzeit</Text>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 10 }}>Zeiträume mit abweichenden Wochenstunden</Text>
            {(state.arbeitszeitRegeln || []).map((r, i) => (
              <View key={r.id}>
                {i > 0 && <Divider t={t} />}
                <View style={{ paddingVertical: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View>
                    <Text style={{ fontSize: 14, color: t.text, fontWeight: "600" }}>{r.wochenStunden} Std/Woche</Text>
                    <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>{formatRuleDate(r.von)} – {formatRuleDate(r.bis)}</Text>
                  </View>
                  <TouchableOpacity onPress={() => dispatch({ type: "DEL_AZ_REGEL", payload: r.id })} style={{ padding: 6 }}>
                    <Icon name="trash2" size={16} color={t.red} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            {(state.arbeitszeitRegeln || []).length > 0 && <Divider t={t} />}
            {!showRegelForm ? (
              <TouchableOpacity onPress={() => setShowRegelForm(true)}
                style={{ paddingTop: (state.arbeitszeitRegeln || []).length > 0 ? 10 : 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon name="plus" size={16} color={t.blue} />
                <Text style={{ fontSize: 14, color: t.blue }}>Winterzeit hinzufügen</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ gap: 10, marginTop: 4 }}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Von</Text>
                    <Input value={regelVon} onChange={setRegelVon} placeholder="TT.MM.JJJJ" t={t} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Bis</Text>
                    <Input value={regelBis} onChange={setRegelBis} placeholder="TT.MM.JJJJ" t={t} />
                  </View>
                </View>
                <View>
                  <Text style={{ fontSize: 12, color: t.text3, marginBottom: 6 }}>Wochenstunden in diesem Zeitraum</Text>
                  <Input value={regelWochen} onChange={setRegelWochen} placeholder="z.B. 36" t={t} keyboardType="decimal-pad" />
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <TouchableOpacity onPress={() => { setShowRegelForm(false); setRegelVon(""); setRegelBis(""); setRegelWochen(""); }}
                    style={{ flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center" }}>
                    <Text style={{ fontSize: 13, color: t.text2 }}>Abbrechen</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={addRegel}
                    style={{ flex: 1, paddingVertical: 9, borderRadius: 10, backgroundColor: t.blue, alignItems: "center" }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: "#fff" }}>Hinzufügen</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </Card>
      )}

      {/* Urlaub */}
      <SectionHeader label="Urlaub" skey="urlaub" emoji="🏖️" />
      {open.urlaub && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 15, color: t.text, flex: 1, marginRight: 12 }}>Urlaubstage / Jahr</Text>
            <Stepper
              onDec={() => set("urlaubstageGesamt", Math.max(1, settings.urlaubstageGesamt - 1))}
              onInc={() => set("urlaubstageGesamt", settings.urlaubstageGesamt + 1)}
              label={String(settings.urlaubstageGesamt)}
            />
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Resturlaub Vorjahr</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Wird zum Jahresurlaub addiert</Text>
            </View>
            <Stepper
              onDec={() => set("urlaubVorjahr", Math.max(0, (settings.urlaubVorjahr || 0) - 1))}
              onInc={() => set("urlaubVorjahr", (settings.urlaubVorjahr || 0) + 1)}
              label={String(settings.urlaubVorjahr || 0)}
            />
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Bereits genommen (dieses Jahr)</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Vor App-Nutzung genommene Urlaubstage</Text>
            </View>
            <Stepper
              onDec={() => set("urlaubGenommenOffset", Math.max(0, (settings.urlaubGenommenOffset || 0) - 1))}
              onInc={() => set("urlaubGenommenOffset", (settings.urlaubGenommenOffset || 0) + 1)}
              label={String(settings.urlaubGenommenOffset || 0)}
            />
          </View>
        </Card>
      )}

      {/* Stunden */}
      <SectionHeader label="Stunden" skey="stunden" emoji="⏱️" />
      {open.stunden && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 14 }}>
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Mitgebrachte Stunden</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Stundenkonto vor App-Start (+ Über / − Minus)</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: t.text4, marginBottom: 4 }}>Stunden</Text>
                <Input
                  value={String(Math.floor(settings.stundenKontoOffset ?? 0))}
                  onChange={v => {
                    const h = Number(v) || 0;
                    const m = Math.round(((settings.stundenKontoOffset ?? 0) % 1) * 60);
                    set("stundenKontoOffset", h + m / 60);
                  }}
                  t={t} keyboardType="numeric" placeholder="0"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: t.text4, marginBottom: 4 }}>Minuten</Text>
                <Input
                  value={String(Math.round(((settings.stundenKontoOffset ?? 0) % 1) * 60))}
                  onChange={v => {
                    const m = Math.min(Number(v) || 0, 59);
                    const h = Math.floor(settings.stundenKontoOffset ?? 0);
                    set("stundenKontoOffset", h + m / 60);
                  }}
                  t={t} keyboardType="numeric" placeholder="0"
                />
              </View>
            </View>
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 14 }}>
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Monatlicher Stundenabzug</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Stunden die monatlich vom Arbeitgeber abgezogen werden</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 4 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: t.text4, marginBottom: 4 }}>Stunden</Text>
                <Input
                  value={String(Math.floor(settings.monatlicheAbzugStunden ?? 0))}
                  onChange={v => {
                    const h = Number(v) || 0;
                    const m = Math.round(((settings.monatlicheAbzugStunden ?? 0) % 1) * 60);
                    set("monatlicheAbzugStunden", h + m / 60);
                  }}
                  t={t} keyboardType="numeric" placeholder="0"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 11, color: t.text4, marginBottom: 4 }}>Minuten</Text>
                <Input
                  value={String(Math.round(((settings.monatlicheAbzugStunden ?? 0) % 1) * 60))}
                  onChange={v => {
                    const m = Math.min(Number(v) || 0, 59);
                    const h = Math.floor(settings.monatlicheAbzugStunden ?? 0);
                    set("monatlicheAbzugStunden", h + m / 60);
                  }}
                  t={t} keyboardType="numeric" placeholder="0"
                />
              </View>
            </View>
            {(settings.monatlicheAbzugStunden ?? 0) > 0 && (() => {
              const modus = settings.monatlicheAbzugModus ?? "alle";
              const selMonate: number[] = settings.monatlicheAbzugMonate ?? [];
              const MON = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
              const toggleMonat = (m: number) => {
                const next = selMonate.includes(m) ? selMonate.filter(x => x !== m) : [...selMonate, m].sort((a,b)=>a-b);
                set("monatlicheAbzugMonate", next);
              };
              return (
                <View style={{ marginTop: 10 }}>
                  <View style={{ flexDirection: "row", borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: t.border, marginBottom: modus === "monate" ? 10 : 0 }}>
                    {([["alle", "Jeden Monat"], ["monate", "Bestimmte Monate"]] as const).map(([val, label]) => (
                      <TouchableOpacity key={val} onPress={() => set("monatlicheAbzugModus", val)} style={{
                        flex: 1, paddingVertical: 9, alignItems: "center",
                        backgroundColor: modus === val ? t.text : "transparent",
                      }}>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: modus === val ? t.bg : t.text3 }}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  {modus === "monate" && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {MON.map((name, i) => {
                        const m = i + 1;
                        const active = selMonate.includes(m);
                        return (
                          <TouchableOpacity key={m} onPress={() => toggleMonat(m)} style={{
                            paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1,
                            borderColor: active ? t.blue : t.border,
                            backgroundColor: active ? t.blue + "22" : "transparent",
                          }}>
                            <Text style={{ fontSize: 13, fontWeight: active ? "700" : "400", color: active ? t.blue : t.text3 }}>{name}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })()}
          </View>
        </Card>
      )}
      </>)}
      {isWorkspace && (
        <Card t={t} style={{ padding: 16, marginBottom: 4 }}>
          <Text style={{ fontSize: 13, color: t.text3, lineHeight: 18 }}>🔒 Arbeitszeit, Urlaub und Stundenkonto werden vom Arbeitgeber festgelegt. Details unter "Mein Vertrag".</Text>
        </Card>
      )}

      {/* Features */}
      <SectionHeader label="Features" skey="features" emoji="⚡" />
      {open.features && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Schichtarbeit</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Schichtplan im Kalender</Text>
            </View>
            <Toggle value={settings.hatSchichtarbeit || false} onChange={v => set("hatSchichtarbeit", v)} t={t} />
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Regiebericht</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Schadenserfassung + Materialien</Text>
            </View>
            <Toggle value={settings.hatRegiebericht !== false} onChange={v => set("hatRegiebericht", v)} t={t} />
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, color: t.text }}>Standort erfassen</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>GPS beim Ein-/Ausstempeln (freiwillig)</Text>
            </View>
            <Toggle value={settings.gpsAktiv || false} onChange={v => set("gpsAktiv", v)} t={t} />
          </View>
        </Card>
      )}

      {/* Kalender */}
      <SectionHeader label="Kalender" skey="kalender" emoji="📅" />
      {open.kalender && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          {/* Bundesland */}
          <TouchableOpacity onPress={isWorkspace ? undefined : () => setBundeslandModalVisible(true)} style={{ paddingVertical: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View>
              <Text style={{ fontSize: 15, color: t.text }}>Feiertage / Bundesland</Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Automatische Feiertage im Kalender</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 14, color: settings.bundesland ? t.blue : t.text4, fontWeight: "500" }}>
                {settings.bundesland
                  ? (BUNDESLAENDER.find(b => b.kuerzel === settings.bundesland)?.name ?? settings.bundesland)
                  : "Keine Auswahl"}
              </Text>
              <Icon name="chevron-right" size={14} color={t.text4} />
            </View>
          </TouchableOpacity>

          {/* Eigene Feiertage */}
          <Divider t={t} />
          <View style={{ paddingVertical: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <View>
                <Text style={{ fontSize: 15, color: t.text }}>Eigene Feiertage</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Z.B. regionale Sonderfeiertage</Text>
              </View>
              <TouchableOpacity
                onPress={() => { setExtraFeiFormOpen(v => !v); setExtraFeiAddDate(""); setExtraFeiAddName(""); }}
                style={{ backgroundColor: t.blue + "22", borderRadius: 8, padding: 6 }}
              >
                <Icon name={extraFeiFormOpen ? "minus" : "plus"} size={16} color={t.blue} />
              </TouchableOpacity>
            </View>

            {extraFeiFormOpen && (
              <View style={{ backgroundColor: t.bg4, borderRadius: 12, padding: 12, marginBottom: 10, gap: 10 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: -4 }}>Datum (jedes Jahr)</Text>
                <View style={{ flexDirection: "row" }}>
                  <DateInput value={extraFeiAddDate} onChange={setExtraFeiAddDate} t={t} />
                </View>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: -4 }}>Name</Text>
                <Input value={extraFeiAddName} onChange={setExtraFeiAddName} placeholder="z.B. Augsburger Friedensfest" t={t} />
                <TouchableOpacity
                  onPress={() => {
                    if (!extraFeiAddDate || !extraFeiAddName.trim()) return;
                    dispatch({ type: "ADD_EXTRA_FEIERTAG", payload: { id: Date.now(), date: extraFeiAddDate, name: extraFeiAddName.trim() } });
                    setExtraFeiAddDate("");
                    setExtraFeiAddName("");
                    setExtraFeiFormOpen(false);
                  }}
                  style={{ backgroundColor: t.blue, borderRadius: 10, paddingVertical: 10, alignItems: "center" }}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>Hinzufügen</Text>
                </TouchableOpacity>
              </View>
            )}

            {(state.extraFeiertage || []).map((ef, i) => {
              const [, m, d] = ef.date.split("-");
              return (
                <View key={ef.id}>
                  {i > 0 && <Divider t={t} />}
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, color: t.text, fontWeight: "500" }}>{ef.name}</Text>
                      <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>{d}.{m}. (jedes Jahr)</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => dispatch({ type: "DEL_EXTRA_FEIERTAG", payload: ef.id })}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Icon name="trash-2" size={16} color={t.red} />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        </Card>
      )}

      {/* Onboarding */}
      <SectionHeader label="Einrichtung" skey="einrichtung" emoji="⚙️" />
      {open.einrichtung && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ fontSize: 15, color: t.text }}>Einrichtungsassistent</Text>
            <TouchableOpacity onPress={() => dispatch({ type: "SET_SETTING", key: "onboardingDone", val: false })}
              style={{ backgroundColor: t.bg4, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ color: t.text2, fontSize: 12 }}>Neu starten</Text>
            </TouchableOpacity>
          </View>
          <Divider t={t} />
          <View style={{ paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View>
              <Text style={{ fontSize: 15, color: t.text }}>
                {isPro ? "⭐ Pro-Version aktiv" : "Free-Version aktiv"}
              </Text>
              <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>
                Test-Toggle (bis RevenueCat)
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => set("isPro", !isPro)}
              style={{
                backgroundColor: isPro ? t.green : t.bg4,
                borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6,
              }}>
              <Text style={{ color: isPro ? "#fff" : t.text2, fontSize: 12, fontWeight: "600" }}>
                {isPro ? "→ Free" : "→ Pro"}
              </Text>
            </TouchableOpacity>
          </View>
        </Card>
      )}

      {/* Export */}
      <ProGateModal visible={proGate.visible} onClose={proGate.hide} onUpgrade={proGate.hide} t={t}
        title="📊 Alles für die Abrechnung"
        description={"Jahresstatistik als PDF, Kalender-Sync & vollständiges Backup.\n\nEin Klick – alles exportiert. Mit Premium verfügbar."} />
      <SectionHeader label="Export" skey="export" emoji="📤" />
      {open.export && (
        <Card t={t} style={{ padding: 0, paddingHorizontal: 16 }}>
          <TouchableOpacity
            onPress={() => isPro ? setExportModalVisible(true) : proGate.show()}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.blue + "22", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>📊</Text>
              </View>
              <View>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "500" }}>Jahresstatistik {!isPro && "⭐"}</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Als PDF exportieren & teilen</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={16} color={t.text4} />
          </TouchableOpacity>
          <Divider t={t} />
          <TouchableOpacity
            onPress={() => isPro ? exportSchichtplanToCalendar() : proGate.show()}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.blue + "22", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>📅</Text>
              </View>
              <View>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "500" }}>Schichtplan exportieren {!isPro && "⭐"}</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>In Handy-Kalender übertragen</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={16} color={t.text4} />
          </TouchableOpacity>
          <Divider t={t} />
          <TouchableOpacity
            onPress={() => isPro ? importIcsToSchichtplan() : proGate.show()}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.blue + "22", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>📥</Text>
              </View>
              <View>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "500" }}>Kalender importieren {!isPro && "⭐"}</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Schichtplan aus .ics Datei laden</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={16} color={t.text4} />
          </TouchableOpacity>
          <Divider t={t} />
          <TouchableOpacity
            onPress={() => isPro ? exportBackup() : proGate.show()}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.blue + "22", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>💾</Text>
              </View>
              <View>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "500" }}>Datensicherung erstellen {!isPro && "⭐"}</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Alle Daten als Datei exportieren</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={16} color={t.text4} />
          </TouchableOpacity>
          <Divider t={t} />
          <TouchableOpacity
            onPress={() => isPro ? importBackup() : proGate.show()}
            activeOpacity={0.7}
            style={{ paddingVertical: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: t.red + "22", alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 18 }}>🔄</Text>
              </View>
              <View>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "500" }}>Datensicherung einspielen {!isPro && "⭐"}</Text>
                <Text style={{ fontSize: 12, color: t.text3, marginTop: 2 }}>Backup-Datei wiederherstellen</Text>
              </View>
            </View>
            <Icon name="chevronRight" size={16} color={t.text4} />
          </TouchableOpacity>
        </Card>
      )}

      {/* Export Modal */}
      <Modal visible={exportModalVisible} transparent animationType="slide" onRequestClose={() => setExportModalVisible(false)}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View style={{ backgroundColor: t.cardBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40 }}>

            {/* Handle */}
            <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.text4 }} />
            </View>

            {/* Header */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ fontSize: 20 }}>📊</Text>
                <Text style={{ fontSize: 17, fontWeight: "700", color: t.text }}>Jahresstatistik</Text>
              </View>
              <TouchableOpacity onPress={() => setExportModalVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}>
                <Icon name="x" size={14} color={t.text2} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 20, paddingTop: 18 }}>

              {/* Jahr-Auswahl */}
              <Text style={{ fontSize: 11, fontWeight: "600", color: t.text3, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>Jahr</Text>
              <View style={{ backgroundColor: t.bg3, borderRadius: 14, borderWidth: 1, borderColor: t.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, marginBottom: 20 }}>
                <TouchableOpacity onPress={() => setExportYear(y => y - 1)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="chevronLeft" size={16} color={t.text} />
                </TouchableOpacity>
                <Text style={{ fontSize: 22, fontWeight: "700", color: t.text }}>{exportYear}</Text>
                <TouchableOpacity onPress={() => setExportYear(y => y + 1)} disabled={exportYear >= currentYear}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: exportYear >= currentYear ? t.bg4 + "55" : t.bg4, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="chevronRight" size={16} color={exportYear >= currentYear ? t.text4 : t.text} />
                </TouchableOpacity>
              </View>

              {/* Statistiken-Auswahl */}
              <Text style={{ fontSize: 11, fontWeight: "600", color: t.text3, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 8 }}>Enthaltene Statistiken</Text>
              <View style={{ backgroundColor: t.bg3, borderRadius: 14, borderWidth: 1, borderColor: t.border, overflow: "hidden", marginBottom: 20 }}>
                {([
                  ["wochenstunden", "📅", "Gearbeitete Stunden", "pro Monat"],
                  ["ueberstunden",  "⏱️", "Überstunden",         "pro Monat"],
                  ["gearbeitete",   "✅", "Gearbeitete Tage",    "pro Monat"],
                  ["krankheitstage","🤒", "Krankheitstage",      "pro Monat"],
                ] as [keyof typeof exportSel, string, string, string][]).map(([key, emoji, title, sub], i, arr) => (
                  <TouchableOpacity
                    key={key}
                    onPress={() => setExportSel(s => ({ ...s, [key]: !s[key] }))}
                    activeOpacity={0.6}
                    style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 13,
                      borderBottomWidth: i < arr.length - 1 ? 1 : 0, borderBottomColor: t.border }}
                  >
                    {/* Checkbox */}
                    <View style={{
                      width: 24, height: 24, borderRadius: 7, borderWidth: 2,
                      borderColor: exportSel[key] ? t.blue : t.text4,
                      backgroundColor: exportSel[key] ? t.blue : "transparent",
                      alignItems: "center", justifyContent: "center", marginRight: 14,
                    }}>
                      {exportSel[key] && <Icon name="check" size={13} color="#fff" />}
                    </View>
                    <Text style={{ fontSize: 17, marginRight: 10 }}>{emoji}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "500", color: t.text }}>{title}</Text>
                      <Text style={{ fontSize: 11, color: t.text3, marginTop: 1 }}>{sub}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>

              {/* PDF Button */}
              <TouchableOpacity
                onPress={doStatistikExport}
                disabled={exportLoading}
                activeOpacity={0.8}
                style={{ backgroundColor: t.blue, borderRadius: 14, paddingVertical: 15, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
              >
                {exportLoading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Text style={{ fontSize: 16 }}>📄</Text>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>PDF erstellen & teilen</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rechtliches */}
      <Card t={t} style={{ padding: 0, paddingHorizontal: 16, marginTop: 10 }}>
        {([
          ["datenschutz", "🔒", "Datenschutzerklärung"],
          ["nutzung",     "📄", "Nutzungsbedingungen"],
          ["impressum",   "🏢", "Impressum"],
        ] as ["datenschutz" | "nutzung" | "impressum", string, string][]).map(([key, emoji, label], i) => (
          <View key={key}>
            {i > 0 && <Divider t={t} />}
            <TouchableOpacity
              onPress={() => setLegalModal(key)}
              activeOpacity={0.7}
              style={{ paddingVertical: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ fontSize: 16 }}>{emoji}</Text>
                <Text style={{ fontSize: 15, color: t.text }}>{label}</Text>
              </View>
              <Icon name="chevronRight" size={16} color={t.text4} />
            </TouchableOpacity>
          </View>
        ))}
      </Card>

      {/* Legal Modal */}
      <Modal visible={legalModal !== null} transparent animationType="slide" onRequestClose={() => setLegalModal(null)}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View style={{ backgroundColor: t.cardBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, maxHeight: "90%" }}>
            <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.text4 }} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Text style={{ fontSize: 18 }}>
                  {legalModal === "datenschutz" ? "🔒" : legalModal === "nutzung" ? "📄" : "🏢"}
                </Text>
                <Text style={{ fontSize: 17, fontWeight: "700", color: t.text }}>
                  {legalModal === "datenschutz" ? "Datenschutzerklärung" : legalModal === "nutzung" ? "Nutzungsbedingungen" : "Impressum"}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setLegalModal(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}>
                <Icon name="x" size={14} color={t.text2} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 20 }}>
              {legalModal === "datenschutz" && (
                <Text style={{ fontSize: 14, color: t.text2, lineHeight: 22 }}>
                  {settings.cloudSync ? `Datenschutzerklärung – clocktap (Workspace)\nStand: Mai 2026\nVerantwortlicher: Alexander Sitek, as@sitekx.de\n\n⚠️ Hinweis: Du nutzt clocktap im Rahmen eines Beschäftigungsverhältnisses. Dein Arbeitgeber ist datenschutzrechtlich Verantwortlicher für deine Arbeitszeitdaten. Wir (SitekX) handeln als Auftragsverarbeiter gemäß Art. 28 DSGVO. Die vollständigen Datenschutzinformationen erhältst du von deinem Arbeitgeber.\n\nNachfolgend informieren wir über Daten, die wir selbst als Verantwortliche verarbeiten.\n\n1. Account-Daten\n\nDaten: E-Mail-Adresse, Name.\nZweck: Authentifizierung und Accountverwaltung.\nRechtsgrundlage: Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\nAnbieter: Supabase Inc., USA – Datenhaltung EU (West EU, Irland / AWS eu-west-1).\nDatenschutz: supabase.com/privacy\nGarantie: EU-Standardvertragsklauseln.\n\n2. Zeiterfassungsdaten (Cloud)\n\nDaten: Arbeitszeiten, Pausen, optionale GPS-Koordinaten, Abwesenheiten, Urlaubsanträge.\nZweck: Bereitstellung der Workspace-Funktion; Zugriff durch deinen Arbeitgeber über das Web-Dashboard.\nRechtsgrundlage: Art. 6 Abs. 1 lit. c DSGVO i. V. m. § 26 BDSG (Beschäftigtendatenschutz).\nAnbieter: Supabase Inc. (EU-Region Irland, eu-west-1).\nHinweis: Dein Arbeitgeber ist Verantwortlicher für diese Verarbeitung und kann diese Daten im clocktap-Dashboard einsehen.\n\n3. KI-Texterkennung (Foto-Import)\n\nDaten: Bilddaten von Belegen.\nZweck: Automatische Texterkennung (OCR).\nRechtsgrundlage: Einwilligung durch aktive Nutzung (Art. 6 Abs. 1 lit. a DSGVO).\nAnbieter: Anthropic PBC, San Francisco, USA.\nDatenschutz: anthropic.com/privacy\nGarantie: EU-Standardvertragsklauseln.\nHinweis: Bilddaten werden nicht für KI-Training verwendet.\n\n4. Push-Benachrichtigungen\n\nDaten: Gerätespezifisches Push-Token.\nZweck: Benachrichtigungen (Genehmigungen, Erinnerungen).\nRechtsgrundlage: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).\nWiderruf: Jederzeit in den Systemeinstellungen unter „Benachrichtigungen".\nAnbieter: Expo/Firebase Cloud Messaging (Google Ireland Limited).\n\n5. Nutzungsanalyse\n\nDaten: Anonyme Ereignisdaten (App-Start, Funktionsnutzung).\nZweck: App-Verbesserung. Keine Personenidentifikation möglich.\nRechtsgrundlage: Berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO).\nAnbieter: Firebase Analytics, Google Ireland Limited, Dublin 4, Irland.\n\n6. Datenweitergabe\n\nDeine Zeiterfassungsdaten sind für deinen Arbeitgeber im clocktap-Dashboard sichtbar. Keine Weitergabe zu Werbezwecken.\n\n7. Deine Rechte (DSGVO)\n\nAuskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20), Widerspruch (Art. 21), Widerruf (Art. 7 Abs. 3).\n\nFür Rechte bezüglich deiner Arbeitszeitdaten: an deinen Arbeitgeber wenden.\nFür Rechte bezüglich deiner Account-Daten: as@sitekx.de\n\nBeschwerde bei der Aufsichtsbehörde:\nBayerisches Landesamt für Datenschutzaufsicht (BayLDA)\nwww.lda.bayern.de\n\n8. Datensicherheit\n\nAlle Datenübertragungen sind TLS/HTTPS-verschlüsselt. Der Datenbankzugriff ist durch Row-Level Security (RLS) abgesichert – du hast ausschließlich Zugriff auf deine eigenen Daten.\n\n9. Kontakt\n\nAlexander Sitek, SitekX\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nE-Mail: as@sitekx.de` : `Datenschutzerklärung – clocktap\nStand: Mai 2026\nVerantwortlicher: Alexander Sitek, as@sitekx.de\n\n1. Allgemeines\n\nDiese Datenschutzerklärung informiert über Art, Umfang und Zweck der Verarbeitung personenbezogener Daten bei der Nutzung der App clocktap. Die App richtet sich an Arbeitnehmer und Selbstständige zur digitalen Zeiterfassung und Erstellung von Regieberichten.\n\nRechtsgrundlagen: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) und Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\n\nPersonenbezogene Daten werden gelöscht oder gesperrt, sobald der Zweck der Speicherung entfällt.\n\n2. Erhobene Daten und Zwecke\n\n2.1 Account-Daten\nDaten: E-Mail-Adresse, Name.\nZweck: Authentifizierung und Accountverwaltung.\nRechtsgrundlage: Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\nAnbieter: Supabase Inc., USA – Datenhaltung EU (Irland, eu-west-1). supabase.com/privacy\nHinweis: Nur Account-Daten gehen an Supabase. Deine Zeiterfassungsdaten bleiben lokal auf dem Gerät.\n\n2.2 Lokale Zeiterfassungsdaten\nDaten: Arbeitszeiteinträge (Start, Ende, Pausen, GPS-Koordinaten), Regieberichte, Einstellungen, Schichtplan, Urlaubsdaten.\nZweck: Kernfunktion der App – Zeiterfassung, Berichtserstellung, Auswertungen.\nRechtsgrundlage: Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\nSpeicherort: Ausschließlich lokal auf dem Gerät. Daten verlassen das Gerät nur auf deinen expliziten Wunsch (z. B. PDF-Export).\n\n2.3 KI-Berichterstellung – Anthropic Claude API (Pro)\nDaten: Zeitblöcke, Mitarbeiterliste, Kundenname, Freitext-Notizen.\nZweck: KI-gestützte Erstellung und Optimierung von Regieberichten.\nRechtsgrundlage: Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\nAnbieter: Anthropic PBC, 548 Market St, San Francisco, CA 94104, USA. anthropic.com/privacy\nGarantie: EU-Standardvertragsklauseln.\nÜbermittelte Daten werden von Anthropic nicht für das Training eigener Modelle verwendet.\n\n2.4 In-App-Käufe – RevenueCat / Google Play (geplant)\nDaten: Kaufhistorie, Abonnementstatus, anonyme Nutzer-ID.\nZweck: Verwaltung von Pro-Abonnements.\nRechtsgrundlage: Vertragserfüllung (Art. 6 Abs. 1 lit. b DSGVO).\nAnbieter: RevenueCat, Inc., Sunnyvale, CA, USA. revenuecat.com/privacy\nZahlungsabwicklung ausschließlich über Google Play – keine Zahlungsdaten werden von der App verarbeitet.\n\n2.5 Standortdaten (GPS)\nDaten: GPS-Koordinaten beim Einstempeln und Ausstempeln.\nZweck: Dokumentation des Arbeitsortes.\nRechtsgrundlage: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).\nStandardmäßig deaktiviert. GPS-Daten werden ausschließlich lokal gespeichert.\n\n2.6 Kalender-Zugriff (Pro)\nDaten: Schichtplan-Einträge (Datum, Zeiten, Bezeichnung).\nZweck: Export in den nativen Android-Kalender.\nRechtsgrundlage: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).\nDie App liest ausschließlich den von ihr selbst erstellten „clocktap"-Kalender.\n\n2.7 Push-Benachrichtigungen\nDaten: Gerätespezifisches Push-Token.\nZweck: Benachrichtigungen (Genehmigungen, Erinnerungen).\nRechtsgrundlage: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).\nWiderruf: Jederzeit in den Systemeinstellungen unter „Benachrichtigungen".\nAnbieter: Expo/Firebase Cloud Messaging (Google Ireland Limited).\n\n2.8 Nutzungsanalyse\nDaten: Anonyme Gerätekennzeichnung (zufällig generierte UUID), Ereignistyp, Zeitstempel.\nZweck: App-Verbesserung. Keine Personenidentifikation möglich.\nRechtsgrundlage: Berechtigtes Interesse (Art. 6 Abs. 1 lit. f DSGVO).\nAnbieter: Firebase Analytics, Google Ireland Limited, Dublin 4, Irland.\n\n2.9 In-App-Feedback\nDaten: Feedback-Kategorie, Titel, Beschreibung, optional: E-Mail-Adresse.\nZweck: App-Verbesserung und Nutzeranfragen.\nRechtsgrundlage: Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).\nAnbieter: Firebase/Firestore, Google Ireland Limited.\nOhne E-Mail-Angabe vollständig anonym.\n\n3. Datenweitergabe\n\nPersonenbezogene Daten werden nur an die genannten Dienstleister weitergegeben. Keine Weitergabe zu Werbezwecken.\n\n4. Datenübertragung in Drittländer\n\nAnthroptic (USA) und RevenueCat (USA) verarbeiten Daten auf Basis von EU-Standardvertragsklauseln (Art. 46 DSGVO).\n\n5. Datenspeicherung und Löschung\n\n- Lokale Daten: gespeichert bis zur Deinstallation.\n- Account-Daten (Supabase): bis zur Account-Löschung, danach innerhalb 30 Tagen.\n- Daten bei Drittanbietern auf Anfrage löschbar (as@sitekx.de).\n\n6. Datensicherheit\n\nAlle Datenübertragungen zur Anthropic API und zu Supabase erfolgen verschlüsselt über TLS. Lokal gespeicherte Daten sind durch die Geräteverschlüsselung von Android geschützt.\n\n7. Deine Rechte (DSGVO)\n\nDu hast folgende Rechte:\n- Auskunft (Art. 15 DSGVO)\n- Berichtigung (Art. 16 DSGVO)\n- Löschung (Art. 17 DSGVO)\n- Einschränkung der Verarbeitung (Art. 18 DSGVO)\n- Datenübertragbarkeit (Art. 20 DSGVO)\n- Widerspruch (Art. 21 DSGVO)\n- Widerruf einer Einwilligung jederzeit (Art. 7 Abs. 3 DSGVO)\n- Beschwerde bei der Aufsichtsbehörde (Art. 77 DSGVO)\n\nKontakt: as@sitekx.de\nBayerisches Landesamt für Datenschutzaufsicht (BayLDA): www.lda.bayern.de\n\n8. Kontakt\n\nAlexander Sitek, SitekX\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nE-Mail: as@sitekx.de\n\n9. Änderungen\n\nDiese Datenschutzerklärung kann aktualisiert werden. Über wesentliche Änderungen wird in der App informiert.`}
                </Text>
              )}
              {legalModal === "nutzung" && (
                <Text style={{ fontSize: 14, color: t.text2, lineHeight: 22 }}>{`Nutzungsbedingungen (AGB) – Clocktap\nStand: April 2026\n\n1. Geltungsbereich und Vertragspartner\n\n1.1 Diese AGB regeln die Nutzung der mobilen Anwendung Clocktap und aller damit verbundenen Dienste.\n\n1.2 Anbieter der App ist:\nAlexander Sitek\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nDeutschland\nE-Mail: as@sitekx.de\n\n1.3 Mit der Nutzung der App akzeptieren Sie diese AGB.\n\n2. Leistungsbeschreibung\n\n2.1 Clocktap ist eine App zur digitalen Zeiterfassung und Erstellung von Regieberichten für Arbeitnehmer, Selbstständige und Handwerksbetriebe.\n\n2.2 Kernfunktionen:\n- Zeiterfassung (Einstempeln / Feierabend) mit optionaler GPS-Dokumentation\n- Überstunden- und Urlaubsverwaltung\n- Erstellung von Regieberichten inkl. Material, Unterschrift und PDF-Export\n- Schichtplanung und Kalender-Export\n- Statistiken und Auswertungen\n- KI-gestützte Berichterstellung (Pro)\n- Cloud-Datensicherung (Pro, geplant nach Launch)\n\n2.3 Die App wird in einer kostenlosen Basisversion und einer kostenpflichtigen Pro-Version angeboten.\n\n2.4 Der Anbieter behält sich vor, den Funktionsumfang der App jederzeit zu ändern, zu erweitern oder einzuschränken, sofern dies für den Nutzer zumutbar ist.\n\n3. Nutzung der App\n\n3.1 Die Nutzung erfordert keine Registrierung. Alle Daten werden lokal auf dem Gerät gespeichert.\n\n3.2 Die Nutzung ist Personen ab 16 Jahren gestattet.\n\n3.3 Der Nutzer ist für die Richtigkeit der eingegebenen Arbeitszeitdaten selbst verantwortlich.\n\n4. KI-generierte Inhalte (Pro)\n\n4.1 Die App nutzt die Anthropic Claude API zur Erstellung von Regieberichten. Diese Inhalte werden automatisiert erstellt und können Fehler enthalten.\n\n4.2 Der Nutzer ist verpflichtet, KI-generierte Berichte vor dem Versand auf Korrektheit zu prüfen. Der Anbieter übernimmt keine Haftung für unrichtige KI-Inhalte.\n\n4.3 Die KI-Funktion erfordert eine aktive Internetverbindung.\n\n5. In-App-Käufe und Abonnements\n\n5.1 Die App bietet ein kostenpflichtiges Pro-Abonnement mit zusätzlichen Funktionen.\n\n5.2 Vertragsschluss durch Bestätigung des Kaufs im Google Play Store.\n\n5.3 Preis: 3,99 € / Monat (inkl. gesetzlicher MwSt.).\n\n5.4 Abonnements verlängern sich automatisch monatlich, sofern sie nicht mindestens 24 Stunden vor Ablauf gekündigt werden.\n\n5.5 Kündigung ausschließlich über:\nGoogle Play Store → Abonnements → Clocktap → Kündigen\nNach Kündigung bleibt der Pro-Zugang bis zum Ende der bezahlten Laufzeit bestehen.\n\n6. Widerrufsrecht\n\n6.1 Sie haben das Recht, binnen 14 Tagen ohne Angabe von Gründen zu widerrufen.\n\n6.2 Widerruf per E-Mail an as@sitekx.de oder schriftlich an:\nAlexander Sitek, Richard-Strauss-Str. 4, 86663 Asbach-Bäumenheim\n\n6.3 Da die Zahlungsabwicklung über Google Play erfolgt, gelten zusätzlich dessen Widerrufs- und Erstattungsrichtlinien.\n\n7. Datensicherung und Datenverlust\n\nAlle App-Daten werden lokal gespeichert. Der Anbieter übernimmt keine Haftung für Datenverlust durch Geräteverlust, Defekt oder Deinstallation. Empfehlung: Regelmäßige Datensicherung über Einstellungen → Export → Datensicherung erstellen.\n\n8. Nutzungsrechte und -pflichten\n\n8.1 Der Anbieter räumt dem Nutzer ein einfaches, nicht übertragbares Recht zur privaten und beruflichen Nutzung der App ein.\n\n8.2 Der Nutzer verpflichtet sich:\na) keine falschen Arbeitszeitdaten einzutragen, um Dritte zu täuschen;\nb) die App nicht für rechtswidrige Zwecke zu nutzen;\nc) die App nicht zu dekompilieren oder den Quellcode zu extrahieren;\nd) die Pro-Version nicht durch technische Mittel zu umgehen.\n\n9. Haftung\n\n9.1 Der Anbieter haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit sowie bei Schäden aus der Verletzung von Leben, Körper oder Gesundheit.\n\n9.2 Im Übrigen ist die Haftung ausgeschlossen, insbesondere für:\n- Datenverlust durch Deinstallation oder Geräteverlust\n- Fehler in KI-generierten Berichten\n- Ausfälle der KI-Funktion durch Nichtverfügbarkeit der Anthropic API\n\n10. Datenschutz\n\nInformationen zur Verarbeitung personenbezogener Daten finden Sie in der Datenschutzerklärung (in dieser App unter Einstellungen → Rechtliches).\n\n11. Änderungen der AGB\n\nÄnderungen werden mindestens vier Wochen vor Inkrafttreten per In-App-Benachrichtigung mitgeteilt.\n\n12. Schlussbestimmungen\n\n12.1 Es gilt deutsches Recht.\n12.2 Gerichtsstand: Asbach-Bäumenheim (für Kaufleute und juristische Personen).\n12.3 OS-Plattform der EU-Kommission: ec.europa.eu/consumers/odr\nWir nehmen nicht an Verbraucherschlichtungsverfahren teil.\n\n13. Kontakt\n\nAlexander Sitek\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nDeutschland\nE-Mail: as@sitekx.de\n\nMuster-Widerrufsformular\n\nAn:\nAlexander Sitek\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nE-Mail: as@sitekx.de\n\nHiermit widerrufe(n) ich/wir den abgeschlossenen Vertrag über folgende digitale Inhalte:\n_________________________________\nBestellt am: _________________________________\nName: _________________________________\nAnschrift: _________________________________\nDatum: _________________________________`}
                </Text>
              )}
              {legalModal === "impressum" && (
                <Text style={{ fontSize: 14, color: t.text2, lineHeight: 22 }}>{`Impressum\n\nAngaben gemäß § 5 DDG\n\nAlexander Sitek\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nDeutschland\n\nKontakt\nE-Mail: as@sitekx.de\n\nVerantwortlich für den Inhalt\nAlexander Sitek\nRichard-Strauss-Str. 4\n86663 Asbach-Bäumenheim\nDeutschland\n\nEU-Streitschlichtung\nDie Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:\nhttps://ec.europa.eu/consumers/odr/\n\nVerbraucherstreitbeilegung\nWir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.\n\nHaftung für Inhalte\nAls Diensteanbieter sind wir gemäß § 7 Abs. 1 DDG für eigene Inhalte der App nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG sind wir als Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.\n\nVerpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden von Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.\n\nHaftung für externe Dienste\nDie App nutzt externe Dienste (Anthropic API, RevenueCat, Google Play), auf deren Inhalte und Datenschutzpraktiken wir keinen Einfluss haben. Für die Inhalte dieser Dienste ist stets der jeweilige Anbieter verantwortlich. Bei Bekanntwerden von Rechtsverletzungen werden wir die Einbindung entsprechender Dienste umgehend prüfen.\n\nUrheberrecht\nDie App Clocktap sowie alle darin enthaltenen Inhalte, Grafiken, Logos und der Quellcode unterliegen dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen Zustimmung des Entwicklers.\n\nDie private Nutzung der App ist im Rahmen der Nutzungsbedingungen gestattet. Eine kommerzielle Weiterverwendung oder Weitergabe ist nicht gestattet. Sollten Sie auf eine Urheberrechtsverletzung aufmerksam werden, bitten wir um einen entsprechenden Hinweis.`}
                </Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Bundesland Modal */}
      <Modal visible={bundeslandModalVisible} transparent animationType="slide" onRequestClose={() => setBundeslandModalVisible(false)}>
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" }}>
          <View style={{ backgroundColor: t.cardBg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, maxHeight: "85%" }}>
            <View style={{ alignItems: "center", paddingTop: 12, paddingBottom: 4 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border }} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 20, paddingBottom: 12 }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: t.text }}>Bundesland wählen</Text>
              <TouchableOpacity onPress={() => setBundeslandModalVisible(false)}>
                <Icon name="x" size={20} color={t.text3} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <TouchableOpacity
                onPress={() => { set("bundesland", ""); setBundeslandModalVisible(false); }}
                style={{
                  paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, marginBottom: 8,
                  backgroundColor: !settings.bundesland ? t.blue + "22" : t.bg4,
                  borderWidth: 1.5, borderColor: !settings.bundesland ? t.blue : "transparent",
                  flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 15, color: !settings.bundesland ? t.blue : t.text3 }}>Keine Auswahl</Text>
              </TouchableOpacity>
              {BUNDESLAENDER.map(bl => (
                <TouchableOpacity
                  key={bl.kuerzel}
                  onPress={() => { set("bundesland", bl.kuerzel); setBundeslandModalVisible(false); }}
                  style={{
                    paddingVertical: 13, paddingHorizontal: 16, borderRadius: 12, marginBottom: 8,
                    backgroundColor: settings.bundesland === bl.kuerzel ? t.blue + "22" : t.bg4,
                    borderWidth: 1.5, borderColor: settings.bundesland === bl.kuerzel ? t.blue : "transparent",
                    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
                  }}
                >
                  <Text style={{ fontSize: 15, fontWeight: settings.bundesland === bl.kuerzel ? "600" : "400", color: settings.bundesland === bl.kuerzel ? t.blue : t.text }}>{bl.name}</Text>
                  <Text style={{ fontSize: 12, color: t.text3 }}>{bl.kuerzel}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* PRO badge */}
      </ScrollView>
      )}
    </View>
  )
}
