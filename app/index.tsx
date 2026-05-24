import React, { useState, useRef } from "react";
import { View, Text, TouchableOpacity, StatusBar, Modal, Linking, AppState, DeviceEventEmitter, Animated as RNAnimated, Image, useWindowDimensions } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GestureDetector, Gesture } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle, withTiming, runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp, persistStateNow } from "../src/store";
import { THEMES } from "../src/theme";
import { logEvent } from "../src/analytics";
import { widgetGetPendingAction, widgetSetRunning } from "../src/clockWidget";
import { processQueue, pullSync, registerPushToken, doSync } from "../src/syncService";
import { Icon } from "../src/Icons";
import ScreenErfassen from "../src/screens/ScreenErfassen";
import ScreenUeberstunden from "../src/screens/ScreenUeberstunden";
import ScreenKalender from "../src/screens/ScreenKalender";
import ScreenRegiebericht from "../src/screens/ScreenRegiebericht";
import ScreenEinstellungen from "../src/screens/ScreenEinstellungen";
import ScreenStatistik from "../src/screens/ScreenStatistik";
import Onboarding from "../src/screens/Onboarding";

type TabId = "erfassen" | "ueberstunden" | "kalender" | "regie" | "statistik" | "settings";

const OPEN_COUNT_KEY = "clocktap_open_count";
const RATING_DONE_KEY = "clocktap_rating_done";
const RATING_THRESHOLD = 5;

// All hooks live here — no early return allowed before hooks
function AppShell() {
  const { state, dispatch } = useApp();
  const t = THEMES[state.settings.darkMode ? "dark" : "light"];
  const [view, setView] = useState<TabId>("erfassen");
  const insets = useSafeAreaInsets();
  const [ratingVisible, setRatingVisible] = useState(false);
  const { width: SCREEN_W } = useWindowDimensions();

  // ── Onboarding Splash ────────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(false);
  const splashLogoOpacity = useRef(new RNAnimated.Value(0)).current;
  const splashLogoScale = useRef(new RNAnimated.Value(0.75)).current;
  const splashTextOpacity = useRef(new RNAnimated.Value(0)).current;

  function startOnboardingSplash() {
    setShowSplash(true);
    splashLogoOpacity.setValue(0);
    splashLogoScale.setValue(0.75);
    splashTextOpacity.setValue(0);
    RNAnimated.sequence([
      RNAnimated.parallel([
        RNAnimated.timing(splashLogoOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        RNAnimated.spring(splashLogoScale, { toValue: 1, friction: 7, tension: 90, useNativeDriver: true }),
      ]),
      RNAnimated.delay(150),
      RNAnimated.timing(splashTextOpacity, { toValue: 1, duration: 350, useNativeDriver: true }),
      RNAnimated.delay(1000),
      RNAnimated.parallel([
        RNAnimated.timing(splashLogoOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
        RNAnimated.timing(splashTextOpacity, { toValue: 0, duration: 350, useNativeDriver: true }),
      ]),
    ]).start(() => setShowSplash(false));
  }

  async function processWidgetPending() {
    const pending = await widgetGetPendingAction();
    if (!pending) return;
    const { action, time, widgetStartTime } = pending;
    if (action === "clock_in") {
      await AsyncStorage.setItem("clocktap_active_session", JSON.stringify({ startTime: time, startLocation: null }));
      widgetSetRunning(true, time);
    } else if (action === "clock_out") {
      const raw = await AsyncStorage.getItem("clocktap_active_session");
      // Fallback auf widgetStartTime falls App zwischen clock_in und clock_out nie geöffnet war
      const startTime = raw ? JSON.parse(raw).startTime : widgetStartTime;
      const dur = time - startTime;
      if (startTime > 0 && dur > 0) {
        dispatch({ type: "ADD_ENTRY", payload: { id: time, start: startTime, end: time, duration: dur, pause: 0, net: dur } });
      }
      await AsyncStorage.removeItem("clocktap_active_session");
      widgetSetRunning(false, 0);
    }
    DeviceEventEmitter.emit("widget_action_processed");
  }

  React.useEffect(() => {
    logEvent("app_open");
    processWidgetPending();
    if (state.settings.cloudSync) {
      doSync(state, dispatch);
      registerPushToken();
    }

    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        processWidgetPending();
        if (state.settings.cloudSync) doSync(state, dispatch);
      }
    });

    (async () => {
      const done = await AsyncStorage.getItem(RATING_DONE_KEY);
      if (done) return;
      const raw = await AsyncStorage.getItem(OPEN_COUNT_KEY);
      const count = parseInt(raw || "0", 10) + 1;
      await AsyncStorage.setItem(OPEN_COUNT_KEY, String(count));
      if (count === RATING_THRESHOLD) setRatingVisible(true);
    })();

    return () => sub.remove();
  }, []);

  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "erfassen", label: "Erfassen", icon: "clock" },
    { id: "ueberstunden", label: "Stunden", icon: "trending" },
    { id: "kalender", label: "Kalender", icon: "calendar" },
    ...(state.settings.hatRegiebericht ? [{ id: "regie" as TabId, label: "Regie", icon: "clipboard" }] : []),
    { id: "statistik", label: "Statistik", icon: "barChart" },
    { id: "settings", label: "Einst.", icon: "settings" },
  ];

  const validView = TABS.find(tab => tab.id === view) ? view : "erfassen";
  const translateX = useSharedValue(0);
  const tabIdx = useSharedValue(TABS.findIndex(t => t.id === validView));
  const tabsCount = useSharedValue(TABS.length);
  React.useEffect(() => {
    tabIdx.value = TABS.findIndex(t => t.id === validView);
    tabsCount.value = TABS.length;
  }, [validView, TABS.length]);

  const switchTabRef = React.useRef<(d: "next" | "prev") => void>(() => {});
  switchTabRef.current = (direction: "next" | "prev") => {
    const idx = TABS.findIndex(t => t.id === validView);
    const nextIdx = idx + (direction === "next" ? 1 : -1);
    if (nextIdx < 0 || nextIdx >= TABS.length) {
      translateX.value = withTiming(0, { duration: 200 });
      return;
    }
    setView(TABS[nextIdx].id);
    translateX.value = direction === "next" ? SCREEN_W : -SCREEN_W;
    translateX.value = withTiming(0, { duration: 220 });
  };
  const stableSwitchTab = React.useCallback((d: "next" | "prev") => switchTabRef.current(d), []);

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .failOffsetY([-20, 20])
    .onUpdate(e => {
      const atStart = tabIdx.value <= 0;
      const atEnd = tabIdx.value >= tabsCount.value - 1;
      const overEdge = (atStart && e.translationX > 0) || (atEnd && e.translationX < 0);
      translateX.value = overEdge ? e.translationX / 4 : e.translationX;
    })
    .onEnd(e => {
      const atStart = tabIdx.value <= 0;
      const atEnd = tabIdx.value >= tabsCount.value - 1;
      const goNext = !atEnd && (e.translationX < -60 || e.velocityX < -600);
      const goPrev = !atStart && (e.translationX > 60 || e.velocityX > 600);
      if (goNext) {
        translateX.value = withTiming(-SCREEN_W, { duration: 200 }, done => {
          if (done) runOnJS(stableSwitchTab)("next");
        });
      } else if (goPrev) {
        translateX.value = withTiming(SCREEN_W, { duration: 200 }, done => {
          if (done) runOnJS(stableSwitchTab)("prev");
        });
      } else {
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const animStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));

  const viewLabels: Record<string, string> = {
    erfassen: new Date().toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" }),
    ueberstunden: "Überstunden",
    kalender: "Kalender",
    regie: "Regiebericht",
    statistik: "Statistik",
    settings: "Einstellungen",
  };

  // Onboarding — safe to return here, all hooks already called above
  if (!state.settings.onboardingDone) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <StatusBar barStyle={state.settings.darkMode ? "light-content" : "dark-content"} backgroundColor={t.bg} />
        <Onboarding onDone={async data => {
            // Erst synchron: dispatch + splash starten (werden zusammen gerendert)
            dispatch({ type: "SET_SETTINGS_MULTI", payload: data });
            startOnboardingSplash();
            // Dann async persistieren
            const newState = { ...state, settings: { ...state.settings, ...data } };
            await persistStateNow(newState);
          }} t={t} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar barStyle={state.settings.darkMode ? "light-content" : "dark-content"} backgroundColor={t.bg2} />

      {/* Header */}
      <View style={{ backgroundColor: t.bg2, borderBottomWidth: 1, borderBottomColor: t.navBorder, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: 20, paddingVertical: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <View>
            <Text style={{ fontSize: 22, fontWeight: "700", letterSpacing: -0.5, color: t.text }}>Clocktap</Text>
          </View>
          <Text style={{ fontSize: 12, color: t.text3 }}>{viewLabels[validView] || ""}</Text>
          {state.settings.firma ? (
            <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: t.text2 }}>{state.settings.firma}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Content */}
      <GestureDetector gesture={swipeGesture}>
        <Animated.View style={[{ flex: 1 }, animStyle]}>
          <View style={{ flex: 1, display: validView === "erfassen" ? "flex" : "none" }}>
            <ScreenErfassen state={state} dispatch={dispatch} t={t} active={validView === "erfassen"} />
          </View>
          <View style={{ flex: 1, display: validView === "ueberstunden" ? "flex" : "none" }}>
            <ScreenUeberstunden state={state} dispatch={dispatch} t={t} active={validView === "ueberstunden"} />
          </View>
          <View style={{ flex: 1, display: validView === "kalender" ? "flex" : "none" }}>
            <ScreenKalender state={state} dispatch={dispatch} t={t} active={validView === "kalender"} />
          </View>
          {state.settings.hatRegiebericht && (
            <View style={{ flex: 1, display: validView === "regie" ? "flex" : "none" }}>
              <ScreenRegiebericht state={state} dispatch={dispatch} t={t} active={validView === "regie"} />
            </View>
          )}
          <View style={{ flex: 1, display: validView === "statistik" ? "flex" : "none" }}>
            <ScreenStatistik state={state} dispatch={dispatch} t={t} active={validView === "statistik"} />
          </View>
          <View style={{ flex: 1, display: validView === "settings" ? "flex" : "none" }}>
            <ScreenEinstellungen state={state} dispatch={dispatch} t={t} active={validView === "settings"} />
          </View>
        </Animated.View>
      </GestureDetector>

      {/* Rating Modal */}
      <Modal visible={ratingVisible} transparent animationType="fade" onRequestClose={() => setRatingVisible(false)}>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 32 }}>
          <View style={{
            backgroundColor: t.cardBg, borderRadius: 24, padding: 28, width: "100%", alignItems: "center",
          }}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>⭐</Text>
            <Text style={{ fontSize: 20, fontWeight: "800", color: t.text, textAlign: "center", marginBottom: 8 }}>
              Gefällt dir Clocktap?
            </Text>
            <Text style={{ fontSize: 14, color: t.text3, textAlign: "center", lineHeight: 20, marginBottom: 24 }}>
              Eine kurze Bewertung im Play Store hilft uns sehr und dauert nur 10 Sekunden!
            </Text>
            <TouchableOpacity
              onPress={async () => {
                await AsyncStorage.setItem(RATING_DONE_KEY, "1");
                setRatingVisible(false);
                Linking.openURL("market://details?id=com.clocktap.app").catch(() =>
                  Linking.openURL("https://play.google.com/store/apps/details?id=com.clocktap.app")
                );
              }}
              style={{
                backgroundColor: t.blue, borderRadius: 14, paddingVertical: 14,
                alignSelf: "stretch", alignItems: "center", marginBottom: 10,
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>Jetzt bewerten ⭐</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                await AsyncStorage.setItem(RATING_DONE_KEY, "1");
                setRatingVisible(false);
              }}
              style={{ paddingVertical: 10 }}
            >
              <Text style={{ color: t.text3, fontSize: 14 }}>Nicht mehr anzeigen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setRatingVisible(false)}
              style={{ paddingVertical: 6 }}
            >
              <Text style={{ color: t.text4, fontSize: 13 }}>Später erinnern</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Tab Bar */}
      <View style={{ backgroundColor: t.navBg, borderTopWidth: 1, borderTopColor: t.navBorder, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: "row", paddingTop: 8, paddingBottom: 8 }}>
          {TABS.map(tab => {
            const active = validView === tab.id;
            return (
              <TouchableOpacity key={tab.id} onPress={() => setView(tab.id)} activeOpacity={0.7}
                style={{ flex: 1, alignItems: "center", gap: 3, paddingVertical: 4 }}>
                <Icon name={tab.icon} size={22} color={active ? t.blue : t.text3} />
                <Text style={{ fontSize: 10, fontWeight: active ? "600" : "400", color: active ? t.blue : t.text3 }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Onboarding → App Splash Overlay */}
      {showSplash && (
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.bg, justifyContent: "center", alignItems: "center" }}>
          <RNAnimated.Image
            source={require("../assets/images/icon.png")}
            style={{ width: 100, height: 100, borderRadius: 24, opacity: splashLogoOpacity, transform: [{ scale: splashLogoScale }] }}
          />
          <RNAnimated.Text style={{ fontSize: 36, fontWeight: "800", color: t.text, marginTop: 20, letterSpacing: -1, opacity: splashTextOpacity }}>
            Clocktap
          </RNAnimated.Text>
          <RNAnimated.Text style={{ fontSize: 12, color: t.text3, marginTop: 6, letterSpacing: 3, opacity: splashTextOpacity }}>
            ZEITERFASSUNG
          </RNAnimated.Text>
        </View>
      )}
    </View>
  );
}

export default function App() {
  return <AppShell />;
}
