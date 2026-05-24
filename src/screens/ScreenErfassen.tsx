import React, { useState, useEffect, useRef } from "react";
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert, AppState as RNAppState, DeviceEventEmitter } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Theme } from "../theme";
import { AppState, Action } from "../store";
import { fmtDur, fmtTime, hoursToMs, dayKey, fmtStdMin, parseFlexTime } from "../utils";
import { Icon } from "../Icons";
import { Card, Label, Divider, Input } from "../Shared";
import HintModal from "../HintModal";
import { logEvent } from "../analytics";
import { widgetSetRunning } from "../clockWidget";
import { nfcIsSupported, nfcScan, nfcCancel } from "../nfcCheckin";
import { generateLocalId, syncEintrag } from "../syncService";

const SESSION_KEY = "clocktap_active_session";

interface Props { state: AppState; dispatch: React.Dispatch<Action>; t: Theme; active?: boolean; }

async function getAddress(): Promise<string | undefined> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return undefined;
    // Cache bis 12h alt akzeptieren — Arbeitsort beim Ausstempeln = gleicher Ort wie Einstempeln
    let loc = await Location.getLastKnownPositionAsync({ maxAge: 12 * 60 * 60 * 1000 });
    // Fallback: frischen Fix, aber max. 5 Sekunden warten
    if (!loc) {
      const timeout = new Promise<null>(res => setTimeout(() => res(null), 5000));
      const fresh = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      loc = await Promise.race([fresh, timeout]);
    }
    if (!loc) return undefined;
    const results = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
    if (!results.length) return undefined;
    const r = results[0];
    const parts = [r.street, r.streetNumber, r.city].filter(Boolean);
    return parts.join(" ") || r.formattedAddress || undefined;
  } catch {
    return undefined;
  }
}


export default function ScreenErfassen({ state, dispatch, t, active }: Props) {
  const scrollRef = React.useRef<ScrollView>(null);
  React.useEffect(() => { if (active) scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [active]);
  const { entries, settings } = state;
  const [isWorking, setIsWorking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [startLocation, setStartLocation] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [showLateStart, setShowLateStart] = useState(false);
  const [lateStartTime, setLateStartTime] = useState("");
  const [lateErr, setLateErr] = useState("");
  const [manDate, setManDate] = useState(() => {
    const d = new Date();
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
  });
  const [showTimePicker, setShowTimePicker] = useState<null | "from" | "to" | "lateStart">(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [manFrom, setManFrom] = useState("");
  const [manTo, setManTo] = useState("");
  const [manErr, setManErr] = useState("");
  const [manLocStart, setManLocStart] = useState("");
  const [manLocEnd, setManLocEnd] = useState("");
  const [manLocStartLoading, setManLocStartLoading] = useState(false);
  const [manLocEndLoading, setManLocEndLoading] = useState(false);
  const [nfcSupported, setNfcSupported] = useState(false);
  const [nfcScanning, setNfcScanning] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function syncSessionFromStorage() {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (raw) {
      try {
        const { startTime: st, startLocation: sl } = JSON.parse(raw);
        if (typeof st === "number" && st > 0) {
          setStartTime(st);
          setStartLocation(sl ?? undefined);
          setIsWorking(true);
          setElapsed(Date.now() - st);
        }
      } catch {}
    } else {
      // Session wurde extern gelöscht (z.B. Widget-Ausstempeln)
      setIsWorking(false);
      setStartTime(null);
      setElapsed(0);
    }
  }

  // Session beim Start wiederherstellen (überlebt App-Close + Reboot)
  useEffect(() => {
    syncSessionFromStorage();
  }, []);

  // Session neu lesen wenn Widget-Action verarbeitet wurde
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener("widget_action_processed", () => {
      syncSessionFromStorage();
    });
    return () => sub.remove();
  }, []);

  // Session neu lesen wenn App in den Vordergrund kommt (ohne Widget)
  useEffect(() => {
    const sub = RNAppState.addEventListener("change", (nextState) => {
      if (nextState === "active") syncSessionFromStorage();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => { nfcIsSupported().then(setNfcSupported); }, []);

  async function handleNfc() {
    if (nfcScanning) { nfcCancel(); setNfcScanning(false); return; }
    setNfcScanning(true);
    const detected = await nfcScan();
    setNfcScanning(false);
    if (detected) toggle();
  }

  useEffect(() => {
    tickRef.current = setInterval(() => {
      if (isWorking && startTime) setElapsed(Date.now() - startTime);
    }, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [isWorking, startTime]);

  const pauseMs = hoursToMs(settings.pauseMinuten / 60);
  const triggerMs = hoursToMs(settings.pauseNachStunden);
  const fixPauseMs = hoursToMs((settings.fixPauseMinuten || 0) / 60);

  function calcFixPause(start: number, end: number): number {
    if (!settings.fixPauseZeit || !settings.fixPauseMinuten) return 0;
    const [h, m] = settings.fixPauseZeit.split(":").map(Number);
    const breakTime = new Date(start);
    breakTime.setHours(h, m, 0, 0);
    if (breakTime.getTime() <= start) breakTime.setDate(breakTime.getDate() + 1);
    return breakTime.getTime() <= end ? fixPauseMs : 0;
  }

  const showPauseWarning = isWorking && elapsed > triggerMs;
  const showFixPauseWarning = isWorking && startTime !== null && calcFixPause(startTime, startTime + elapsed) > 0;
  const net = Math.max(0, elapsed - (showPauseWarning ? pauseMs : 0) - (showFixPauseWarning ? fixPauseMs : 0));

  async function toggle() {
    if (toggling) return;
    setToggling(true);
    try {
      const addr = settings.gpsAktiv ? await getAddress() : undefined;
      if (!isWorking) {
        const now = Date.now();
        setStartLocation(addr);
        setStartTime(now); setIsWorking(true); setElapsed(0);
        await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ startTime: now, startLocation: addr ?? null }));
        widgetSetRunning(true, now, addr);
        logEvent("stempel_ein");
      } else {
        const end = Date.now();
        const dur = end - (startTime || end);
        const autoPause = dur > triggerMs ? pauseMs : 0;
        const fixP = calcFixPause(startTime!, end);
        const pause = autoPause + fixP;
        const localId = generateLocalId();
        dispatch({ type: "ADD_ENTRY", payload: {
          id: end, local_id: localId, start: startTime!, end, duration: dur, pause, net: dur - pause,
          locationStart: startLocation, locationEnd: addr,
        }});
        if (settings.cloudSync) syncEintrag(localId, startTime!, end, pause).catch(() => {});
        await AsyncStorage.removeItem(SESSION_KEY);
        widgetSetRunning(false, 0);
        setIsWorking(false); setStartTime(null); setElapsed(0); setStartLocation(undefined);
      }
    } finally {
      setToggling(false);
    }
  }

  async function fetchManLoc(field: "start" | "end") {
    if (field === "start") { setManLocStartLoading(true); const a = await getAddress(); setManLocStart(a || ""); setManLocStartLoading(false); }
    else { setManLocEndLoading(true); const a = await getAddress(); setManLocEnd(a || ""); setManLocEndLoading(false); }
  }

  function saveManual() {
    setManErr("");
    const fromParsed = parseFlexTime(manFrom);
    const toParsed = parseFlexTime(manTo);
    if (!fromParsed || !toParsed) { setManErr("Bitte Von und Bis ausfüllen. Erlaubt: 7, 7:30, 730"); return; }
    setManFrom(fromParsed); setManTo(toParsed);
    const dateParts = manDate.split(".");
    if (dateParts.length !== 3) { setManErr("Ungültiges Datum. Format: TT.MM.JJJJ"); return; }
    const isoDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
    const start = new Date(`${isoDate}T${fromParsed}`).getTime();
    const end = new Date(`${isoDate}T${toParsed}`).getTime();
    if (isNaN(start) || isNaN(end)) { setManErr("Ungültiges Datum."); return; }
    if (end <= start) { setManErr("Endzeit muss nach Startzeit liegen."); return; }
    const dur = end - start;
    const autoPause = dur > triggerMs ? pauseMs : 0;
    const fixP = calcFixPause(start, end);
    const pause = autoPause + fixP;
    const manLocalId = generateLocalId();
    dispatch({ type: "ADD_ENTRY", payload: {
      id: start + Math.random(), local_id: manLocalId, start, end, duration: dur, pause, net: dur - pause, manual: true,
      locationStart: manLocStart || undefined, locationEnd: manLocEnd || undefined,
    }});
    if (settings.cloudSync) syncEintrag(manLocalId, start, end, pause).catch(() => {});
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    setManFrom(""); setManTo(""); setManLocStart(""); setManLocEnd(""); setManDate(`${dd}.${mm}.${today.getFullYear()}`); setShowManual(false);
  }

  const todayEntries = entries.filter(e => dayKey(e.start) === dayKey(Date.now()));
  const todayNet = todayEntries.reduce((a, e) => a + e.net, 0);
  const sollMs = hoursToMs(settings.sollStunden);
  const pct = Math.min(100, (todayNet / sollMs) * 100);

  // ── Wochenfortschritt ─────────────────────────────────────────────────────
  const apt = settings.arbeitstageProWoche || 5;
  const wochenSollMs = hoursToMs(settings.sollStunden) * apt;
  const now = new Date();
  const monday = new Date(now); monday.setHours(0,0,0,0);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 7);
  const weekEntries = entries.filter(e => e.start >= monday.getTime() && e.start < sunday.getTime());
  const weekNet = weekEntries.reduce((a, e) => a + e.net, 0);
  const weekPct = wochenSollMs > 0 ? weekNet / wochenSollMs : 0;

  const WD_LABELS = ["Mo","Di","Mi","Do","Fr","Sa","So"];
  const weekDays = Array.from({ length: apt <= 5 ? 5 : apt }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const dayMs = entries.filter(e => dayKey(e.start) === dayKey(d.getTime())).reduce((a, e) => a + e.net, 0);
    const done = dayMs >= sollMs * 0.9; // 90% des Tagessolls = erreicht
    const worked = dayMs > 0;
    const isPast = d < now || dayKey(d.getTime()) === dayKey(now.getTime());
    return { label: WD_LABELS[i], done, worked, isPast };
  });

  const motivText = weekPct === 0
    ? { text: "Guten Start!", emoji: "🌅" }
    : weekPct < 0.25
    ? { text: "Los geht's!", emoji: "💪" }
    : weekPct < 0.5
    ? { text: "Gut unterwegs!", emoji: "🔥" }
    : weekPct < 0.75
    ? { text: "Halbzeit!", emoji: "⚡" }
    : weekPct < 1
    ? { text: "Fast geschafft!", emoji: "🚀" }
    : { text: "Wochenziel erreicht!", emoji: "🏆" };


  return (
    <View style={{ flex: 1 }}>
      <HintModal storageKey="hint_erfassen_v2" t={t} steps={[
        { emoji: "⏱️", title: "Einstempeln & Ausstempeln", description: "Tippe auf den großen Button um deine Arbeitszeit zu starten oder zu beenden. Die Zeit läuft auch wenn du die App schließt." },
        { emoji: "✏️", title: "Manueller Eintrag", description: "Über den '+'-Button kannst du vergangene Zeiten nachtragen. Mit '⏪ Nachträglich' kannst du den Timer rückwirkend starten, falls du vergessen hast einzustempeln." },
        { emoji: "🟩", title: "Home Screen Widget", description: "Füge das Clocktap Widget zu deinem Home Screen hinzu: Halte eine freie Stelle auf dem Home Screen gedrückt → Widgets → Clocktap. So stempelst du direkt vom Home Screen ein und aus." },
      ]} />
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>

      {/* Big timer */}
      <View style={{ alignItems: "center", paddingTop: 48, paddingBottom: 40, paddingHorizontal: 24 }}>
        <Text style={{
          fontSize: 68, fontWeight: "700", letterSpacing: -3, lineHeight: 72,
          color: isWorking ? t.text : t.text4,
          fontVariant: ["tabular-nums"],
        }}>
          {fmtDur(isWorking ? net : 0)}
        </Text>
        <Text style={{ fontSize: 13, color: t.text3, marginTop: 10, letterSpacing: 0.5 }}>
          {isWorking ? `Eingestempelt seit ${fmtTime(startTime!)}` : "Tippe zum Einstempeln"}
        </Text>
        {isWorking && startLocation && (
          <Text style={{ fontSize: 12, color: t.text3, marginTop: 4 }}>📍 {startLocation}</Text>
        )}

        {(showPauseWarning || showFixPauseWarning) && (
          <View style={{
            backgroundColor: t.orange + "22", borderWidth: 1, borderColor: t.orange + "44",
            borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6, marginTop: 14, gap: 2,
          }}>
            {showPauseWarning && <Text style={{ fontSize: 12, color: t.orange }}>⏸ {settings.pauseMinuten} Min. Pause wird abgezogen</Text>}
            {showFixPauseWarning && <Text style={{ fontSize: 12, color: t.orange }}>⏸ {settings.fixPauseMinuten} Min. Fixpause ({settings.fixPauseZeit}) wird abgezogen</Text>}
          </View>
        )}

        {/* Button */}
        <View style={{ marginTop: 44, alignItems: "center" }}>
          <TouchableOpacity
            onPress={toggle}
            disabled={toggling}
            activeOpacity={0.85}
            style={{
              width: 100, height: 100, borderRadius: 50,
              backgroundColor: isWorking ? t.red : t.text,
              alignItems: "center", justifyContent: "center",
              shadowColor: isWorking ? t.red : "#000",
              shadowOpacity: 0.4, shadowRadius: 16, elevation: 10,
              opacity: toggling ? 0.6 : 1,
            }}
          >
            {toggling
              ? <ActivityIndicator size="large" color={isWorking ? "#fff" : t.bg} />
              : <Icon name={isWorking ? "stop" : "play"} size={32} color={isWorking ? "#fff" : t.bg} />
            }
          </TouchableOpacity>
          <Text style={{ fontSize: 12, color: t.text3, marginTop: 14, letterSpacing: 1.2, fontWeight: "600" }}>
            {isWorking ? "FEIERABEND" : "ARBEIT BEGINNEN"}
          </Text>

          {!isWorking && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16, justifyContent: "center" }}>
              <TouchableOpacity
                onPress={() => { setShowLateStart(s => !s); setShowManual(false); }}
                style={{ borderWidth: 1, borderColor: t.border, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 7 }}>
                <Text style={{ color: t.text3, fontSize: 13 }}>
                  {showLateStart ? "Abbrechen" : "⏪ Nachträglich einstempeln"}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setShowManual(s => !s); setShowLateStart(false); }}
                style={{ borderWidth: 1, borderColor: t.border, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 7 }}>
                <Text style={{ fontSize: 13, color: t.text3 }}>
                  {showManual ? "Abbrechen" : "✏️ Manuell eintragen"}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {nfcSupported && (
            <TouchableOpacity
              onPress={handleNfc}
              disabled={toggling}
              style={{
                marginTop: 14, flexDirection: "row", alignItems: "center", gap: 7,
                borderWidth: 1,
                borderColor: nfcScanning ? t.blue : t.border,
                borderRadius: 20, paddingHorizontal: 18, paddingVertical: 7,
                backgroundColor: nfcScanning ? t.blue + "18" : "transparent",
              }}
            >
              <Text style={{ fontSize: 13 }}>📡</Text>
              <Text style={{ fontSize: 13, color: nfcScanning ? t.blue : t.text3, fontWeight: nfcScanning ? "600" : "400" }}>
                {nfcScanning ? "Handy an NFC-Tag halten… Abbrechen" : "NFC einstempeln"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Nachträglich einstempeln */}
      {showLateStart && !isWorking && (
        <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
          <Card t={t}>
            <Label t={t}>Nachträglich einstempeln</Label>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 8 }}>
              Ab welcher Uhrzeit hast du heute begonnen?
            </Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Input
                value={lateStartTime}
                onChange={setLateStartTime}
                placeholder="07:30"
                t={t}
                keyboardType="numeric"
                style={{ flex: 1 }}
              />
              <TouchableOpacity
                onPress={() => setShowTimePicker("lateStart")}
                style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
              >
                <Text style={{ fontSize: 20 }}>🕐</Text>
              </TouchableOpacity>
            </View>
            {lateErr ? <Text style={{ fontSize: 12, color: t.red, marginTop: 6 }}>{lateErr}</Text> : null}
            <TouchableOpacity
              onPress={async () => {
                setLateErr("");
                const parsed = parseFlexTime(lateStartTime);
                if (!parsed) { setLateErr("Ungültige Zeit. Erlaubt: 7, 7:30, 730"); return; }
                setLateStartTime(parsed);
                const [h, m] = parsed.split(":").map(Number);
                const now = new Date();
                const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime();
                if (start >= Date.now()) { setLateErr("Startzeit muss in der Vergangenheit liegen."); return; }
                const addr = settings.gpsAktiv ? await getAddress() : undefined;
                setStartTime(start);
                setStartLocation(addr);
                setIsWorking(true);
                setElapsed(Date.now() - start);
                await AsyncStorage.setItem(SESSION_KEY, JSON.stringify({ startTime: start, startLocation: addr ?? null }));
                setShowLateStart(false);
                setLateStartTime("");
              }}
              style={{
                marginTop: 12, backgroundColor: t.text, borderRadius: 10,
                paddingVertical: 12, alignItems: "center",
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "700", color: t.bg }}>⏱ Timer starten</Text>
            </TouchableOpacity>
          </Card>
        </View>
      )}

      {/* Manual entry */}
      {showManual && (
        <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
          <Card t={t}>
            <Label t={t}>Eintrag nachtragen</Label>
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 5 }}>Datum</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
              <Input value={manDate} onChange={setManDate} placeholder="04.04.2026" t={t} keyboardType="numeric" style={{ flex: 1 }} />
              <TouchableOpacity
                onPress={() => setShowDatePicker(true)}
                style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
              >
                <Text style={{ fontSize: 20 }}>📅</Text>
              </TouchableOpacity>
            </View>
            {showDatePicker && (
              <DateTimePicker
                value={(() => {
                  const parts = manDate.split(".");
                  if (parts.length === 3) {
                    const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                    if (!isNaN(d.getTime())) return d;
                  }
                  return new Date();
                })()}
                mode="date"
                display="default"
                onChange={(event, date) => {
                  setShowDatePicker(false);
                  if (event.type === "set" && date) {
                    const day = String(date.getDate()).padStart(2, "0");
                    const month = String(date.getMonth() + 1).padStart(2, "0");
                    const year = date.getFullYear();
                    setManDate(`${day}.${month}.${year}`);
                  }
                }}
              />
            )}
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: 5 }}>Von</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Input value={manFrom} onChange={setManFrom} placeholder="08:00" t={t} keyboardType="numeric" style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={() => setShowTimePicker("from")}
                    style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ fontSize: 20 }}>🕐</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 12, color: t.text3, marginBottom: 5 }}>Bis</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Input value={manTo} onChange={setManTo} placeholder="16:30" t={t} keyboardType="numeric" style={{ flex: 1 }} />
                  <TouchableOpacity
                    onPress={() => setShowTimePicker("to")}
                    style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
                  >
                    <Text style={{ fontSize: 20 }}>🕐</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            {/* Standort Einstempeln */}
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 5 }}>Standort Beginn (optional)</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
              <Input value={manLocStart} onChange={setManLocStart} placeholder="z.B. Baustelle Musterstr." t={t} style={{ flex: 1 }} />
              <TouchableOpacity
                onPress={() => fetchManLoc("start")}
                disabled={manLocStartLoading}
                style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
              >
                {manLocStartLoading ? <ActivityIndicator size="small" color={t.text3} /> : <Text style={{ fontSize: 20 }}>📍</Text>}
              </TouchableOpacity>
            </View>

            {/* Standort Ausstempeln */}
            <Text style={{ fontSize: 12, color: t.text3, marginBottom: 5 }}>Standort Ende (optional)</Text>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
              <Input value={manLocEnd} onChange={setManLocEnd} placeholder="z.B. Werkstatt Hauptstr." t={t} style={{ flex: 1 }} />
              <TouchableOpacity
                onPress={() => fetchManLoc("end")}
                disabled={manLocEndLoading}
                style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.bg4, alignItems: "center", justifyContent: "center" }}
              >
                {manLocEndLoading ? <ActivityIndicator size="small" color={t.text3} /> : <Text style={{ fontSize: 20 }}>📍</Text>}
              </TouchableOpacity>
            </View>

            {manErr ? <Text style={{ fontSize: 12, color: t.red, marginBottom: 8 }}>{manErr}</Text> : null}
            <TouchableOpacity onPress={saveManual} style={{
              backgroundColor: t.text, borderRadius: 10, padding: 12, alignItems: "center",
            }}>
              <Text style={{ color: t.bg, fontSize: 15, fontWeight: "600" }}>Speichern</Text>
            </TouchableOpacity>
          </Card>
        </View>
      )}

      {showTimePicker && (
        <DateTimePicker
          value={(() => {
            const d = new Date();
            const str = showTimePicker === "lateStart" ? lateStartTime : showTimePicker === "from" ? manFrom : manTo;
            if (str && /^\d{2}:\d{2}$/.test(str)) {
              const [h, m] = str.split(":").map(Number);
              d.setHours(h, m, 0, 0);
            }
            return d;
          })()}
          mode="time"
          is24Hour={true}
          display="default"
          onChange={(event, date) => {
            const field = showTimePicker;
            setShowTimePicker(null);
            if (event.type === "set" && date) {
              const h = String(date.getHours()).padStart(2, "0");
              const m = String(date.getMinutes()).padStart(2, "0");
              if (field === "lateStart") setLateStartTime(`${h}:${m}`);
              else if (field === "from") setManFrom(`${h}:${m}`);
              else setManTo(`${h}:${m}`);
            }
          }}
        />
      )}

      {/* Day progress */}
      <View style={{ paddingHorizontal: 16 }}>
        <Card t={t}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
            <Text style={{ fontSize: 13, color: t.text2 }}>Tagesziel {settings.sollStunden}h</Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: pct >= 100 ? t.green : t.text }}>
              {fmtDur(todayNet, false)} / {settings.sollStunden}:00
            </Text>
          </View>
          <View style={{ height: 4, backgroundColor: t.bg4, borderRadius: 2 }}>
            <View style={{ height: 4, borderRadius: 2, width: `${pct}%` as any, backgroundColor: pct >= 100 ? t.green : t.blue }} />
          </View>
        </Card>

        {todayEntries.length > 0 && (
          <>
            <Label t={t}>Heute</Label>
            <Card t={t} style={{ padding: 0, overflow: "hidden" }}>
              {todayEntries.map((e, i) => (
                <View key={e.id}>
                  {i > 0 && <Divider t={t} />}
                  <View style={{ padding: 14 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, color: t.text }}>
                          {fmtTime(e.start)} – {fmtTime(e.end)}
                          {e.manual ? <Text style={{ fontSize: 10, color: t.text3 }}> manuell</Text> : ""}
                        </Text>
                        {e.pause > 0 && <Text style={{ fontSize: 11, color: t.text3, marginTop: 2 }}>inkl. {settings.pauseMinuten} Min. Pause</Text>}
                      </View>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                        <Text style={{ fontSize: 17, fontWeight: "600", color: t.text }}>{fmtDur(e.net, false)}</Text>
                        <TouchableOpacity
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          onPress={() => Alert.alert("Eintrag löschen", "Diesen Eintrag wirklich löschen?", [
                            { text: "Abbrechen", style: "cancel" },
                            { text: "Löschen", style: "destructive", onPress: () => dispatch({ type: "DEL_ENTRY", payload: e.id }) },
                          ])}
                        >
                          <Icon name="trash2" size={16} color={t.text3} />
                        </TouchableOpacity>
                      </View>
                    </View>
                    {(e.locationStart || e.locationEnd) && (
                      <View style={{ marginTop: 6, gap: 2 }}>
                        {e.locationStart && <Text style={{ fontSize: 11, color: t.text3 }}>📍 {e.locationStart}</Text>}
                        {e.locationEnd && <Text style={{ fontSize: 11, color: t.text3 }}>🏁 {e.locationEnd}</Text>}
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </Card>
          </>
        )}

        {/* Wochenfortschritt — kompakt */}
        <View style={{ backgroundColor: t.cardBg, borderRadius: 16, borderWidth: 1, borderColor: t.cardBorder, paddingHorizontal: 16, paddingVertical: 12, marginTop: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ fontSize: 15 }}>{motivText.emoji}</Text>
              <Text style={{ fontSize: 13, fontWeight: "600", color: weekPct >= 1 ? t.green : t.text }}>{motivText.text}</Text>
            </View>
            <Text style={{ fontSize: 13, color: t.text3 }}>
              <Text style={{ fontWeight: "700", color: weekPct >= 1 ? t.green : t.blue }}>{fmtStdMin(weekNet / 3600000)}</Text>
              {" / "}{fmtStdMin(wochenSollMs / 3600000)}
            </Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: t.bg4, marginBottom: 10, overflow: "hidden" }}>
            <View style={{
              position: "absolute", left: 0, top: 0, bottom: 0,
              width: `${Math.min(weekPct * 100, 100)}%` as any,
              borderRadius: 3,
              backgroundColor: weekPct >= 1 ? t.green : t.blue,
            }} />
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            {weekDays.map((d, i) => (
              <View key={i} style={{ alignItems: "center", gap: 3 }}>
                <View style={{
                  width: 28, height: 28, borderRadius: 14,
                  backgroundColor: d.done ? t.green : d.worked ? t.blue + "33" : t.bg4,
                  borderWidth: 1, borderColor: d.done ? t.green : d.worked ? t.blue : t.cardBorder,
                  alignItems: "center", justifyContent: "center",
                }}>
                  <Text style={{ fontSize: 11 }}>{d.done ? "✓" : d.worked ? "·" : ""}</Text>
                </View>
                <Text style={{ fontSize: 9, color: d.done ? t.green : d.worked ? t.blue : t.text4, fontWeight: d.done || d.worked ? "700" : "400" }}>{d.label}</Text>
              </View>
            ))}
          </View>
        </View>

      </View>
      </ScrollView>
    </View>
  );
}
