import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable,
  SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { SIZES, LABEL, loads, balanceState, bump, nudgeTasks } from './balance';

const C = { bg: '#EEF3EE', ink: '#16261C', mute: '#66756B', green: '#24724D', dark: '#1B5B3C', card: '#fff',
  tint: '#E3F0E7', line: '#DCE6DE', warn: '#FBEDE3', warnInk: '#B4531F' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const byName = (a, b) => a.name.localeCompare(b.name);
const parseCode = (url) => (url && url.match(/join\/([A-Za-z0-9]+)|code=([A-Za-z0-9]+)/i)?.slice(1).find(Boolean)) || null;
const fmt = (d) => (d ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : 'Date to be set');

/* ---------- small UI pieces ---------- */
const Btn = ({ t, onPress, kind, disabled, style }) => (
  <Pressable disabled={disabled} onPress={onPress} style={[s.btn, kind === 'ghost' && s.ghost, disabled && { opacity: 0.4 }, style]}>
    <Text style={[s.btnT, kind === 'ghost' && { color: C.green }]}>{t}</Text>
  </Pressable>
);
const Card = ({ children, style }) => <View style={[s.card, style]}>{children}</View>;
const Chip = ({ t, on, onPress }) => (
  <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]}><Text style={[s.chipT, on && { color: '#fff' }]}>{t}</Text></Pressable>
);
const Dot = ({ name }) => <View style={s.dot}><Text style={s.dotT}>{(name || '?')[0].toUpperCase()}</Text></View>;
const H = ({ t, sub }) => (<View style={{ marginBottom: 12 }}><Text style={s.h1}>{t}</Text>{sub ? <Text style={s.mute}>{sub}</Text> : null}</View>);
const Sheet = ({ open, onClose, children }) => (
  <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.scrim}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <ScrollView style={s.sheet} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </KeyboardAvoidingView>
  </Modal>
);
const Loading = () => <View style={s.center}><ActivityIndicator color={C.green} /></View>;

/* ---------- event data hook (query + realtime) ---------- */
function useEvent(eid) {
  const [d, setD] = useState({ members: [], tasks: [], loaded: false });
  const load = useCallback(async () => {
    const [m, t] = await Promise.all([
      supabase.from('event_members').select('user_id, users(display_name)').eq('event_id', eid),
      supabase.from('tasks').select('*, task_assignees(user_id)').eq('event_id', eid).order('created_at'),
    ]);
    setD({
      loaded: true,
      members: (m.data || []).map((x) => ({ id: x.user_id, name: x.users?.display_name || 'Guest' })).sort(byName),
      tasks: (t.data || []).map((x) => ({ ...x, assignees: x.task_assignees.map((a) => a.user_id) })),
    });
  }, [eid]);
  useEffect(() => {
    load();
    const ch = supabase.channel('ev-' + eid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `event_id=eq.${eid}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_assignees' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [eid, load]);
  return { ...d, reload: load };
}

/* ---------- root ---------- */
export default function App() {
  const [uid, setUid] = useState(null);
  const [name, setName] = useState(null);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState([]);
  const [route, setRoute] = useState({ name: 'home' });
  const [code, setCode] = useState('');
  const [toast, setToast] = useState(null);

  const say = (m) => { setToast(m); setTimeout(() => setToast(null), 2600); };
  const log = useCallback((event_name, screen, payload = {}) => {
    if (uid) supabase.from('interaction_events').insert({ user_id: uid, event_name, screen, payload }).then(() => {});
  }, [uid]);

  useEffect(() => {
    (async () => {
      try {
        let { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          const r = await supabase.auth.signInAnonymously();
          if (r.error) throw r.error;
          session = r.data.session;
        }
        setUid(session.user.id);
        const { data: u } = await supabase.from('users').select('display_name').eq('id', session.user.id).maybeSingle();
        setName(u?.display_name ?? null);
        const c = parseCode(await Linking.getInitialURL());
        if (c) { setCode(c.toUpperCase()); setRoute({ name: 'join' }); }
      } catch (e) { Alert.alert('Could not start Carry', e.message); }
      setReady(true);
    })();
    const sub = Linking.addEventListener('url', ({ url }) => {
      const c = parseCode(url);
      if (c) { setCode(c.toUpperCase()); setRoute({ name: 'join' }); }
    });
    return () => sub.remove();
  }, []);

  const loadEvents = useCallback(async () => {
    if (!uid) return;
    const { data } = await supabase.from('event_members').select('events(*)').eq('user_id', uid);
    setEvents((data || []).map((r) => r.events).filter(Boolean).sort((a, b) => new Date(a.starts_at || 8e15) - new Date(b.starts_at || 8e15)));
  }, [uid]);
  useEffect(() => { if (name) loadEvents(); }, [name, route.name, loadEvents]);

  const ctx = { uid, name, events, log, say, loadEvents };
  const go = (r) => setRoute(r);
  if (!ready) return <Loading />;

  let body;
  if (!name || route.name === 'join') body = <Join ctx={ctx} code={code} go={go} onNamed={setName} canCancel={!!name} />;
  else if (route.name === 'event') body = <EventScreen ctx={ctx} eid={route.eid} go={go} />;
  else if (route.name === 'task') body = <TaskScreen ctx={ctx} eid={route.eid} tid={route.tid} go={go} />;
  else if (route.name === 'mine') body = <Mine ctx={ctx} go={go} />;
  else body = <Home ctx={ctx} go={go} />;

  const tabs = name && ['home', 'mine'].includes(route.name);
  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>{body}</View>
      {toast ? <View style={s.toast}><Text style={{ color: '#fff' }}>{toast}</Text></View> : null}
      {tabs ? (
        <View style={s.tabs}>
          {[['home', 'Home'], ['mine', 'My tasks']].map(([k, l]) => (
            <Pressable key={k} style={s.tab} onPress={() => go({ name: k })}>
              <Text style={[s.tabT, route.name === k && { color: C.green, fontWeight: '700' }]}>{l}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/* ---------- join / create ---------- */
function Join({ ctx, code, go, onNamed, canCancel }) {
  const [mode, setMode] = useState('join');
  const [nm, setNm] = useState(ctx.name || '');
  const [cd, setCd] = useState(code || '');
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    let res;
    if (mode === 'join') res = await supabase.rpc('join_event', { p_code: cd, p_name: nm.trim() });
    else {
      const d = date ? new Date(`${date}T18:00:00`) : null;
      if (date && isNaN(d)) { setBusy(false); return Alert.alert('Check the date', 'Use the format YYYY-MM-DD, for example 2026-12-05.'); }
      res = await supabase.rpc('create_event', { p_name: nm.trim(), p_title: title.trim(), p_place: place.trim() || null, p_starts_at: d ? d.toISOString() : null });
    }
    setBusy(false);
    if (res.error) return Alert.alert(mode === 'join' ? 'Could not join' : 'Could not create the event', res.error.message);
    onNamed(nm.trim());
    ctx.loadEvents();
    go({ name: 'event', eid: res.data.id });
  };
  const ok = nm.trim() && (mode === 'join' ? cd.trim().length >= 6 : title.trim());
  return (
    <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <H t="Carry" sub="Plan a one-off event together and keep the work feeling fair." />
      <View style={s.row}><Chip t="Join with a code" on={mode === 'join'} onPress={() => setMode('join')} /><Chip t="New event" on={mode === 'create'} onPress={() => setMode('create')} /></View>
      <Text style={s.label}>Your name</Text>
      <TextInput style={s.input} value={nm} onChangeText={setNm} placeholder="Alex" />
      {mode === 'join' ? (<>
        <Text style={s.label}>Invite code</Text>
        <TextInput style={s.input} value={cd} onChangeText={(v) => setCd(v.toUpperCase())} autoCapitalize="characters" placeholder="8-character code" />
      </>) : (<>
        <Text style={s.label}>Event name</Text>
        <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Rooftop dinner" />
        <Text style={s.label}>Place (optional)</Text>
        <TextInput style={s.input} value={place} onChangeText={setPlace} placeholder="Sam's rooftop" />
        <Text style={s.label}>Date (optional, YYYY-MM-DD)</Text>
        <TextInput style={s.input} value={date} onChangeText={setDate} placeholder="2026-12-05" />
      </>)}
      <Btn t={busy ? 'Working…' : mode === 'join' ? 'Join event' : 'Create event'} disabled={!ok || busy} onPress={submit} style={{ marginTop: 16 }} />
      {canCancel ? <Btn t="Back to Home" kind="ghost" onPress={() => go({ name: 'home' })} style={{ marginTop: 8 }} /> : null}
    </ScrollView>
  );
}

/* ---------- home ---------- */
function Home({ ctx, go }) {
  const { uid, name, events, say } = ctx;
  const [reqs, setReqs] = useState([]);
  const loadReqs = useCallback(async () => {
    const { data } = await supabase.from('task_flags')
      .select('id, note, task_id, tasks(title, event_id), sender:users!task_flags_user_id_fkey(display_name)')
      .eq('asked_user_id', uid).is('response', null);
    setReqs(data || []);
  }, [uid]);
  useEffect(() => { loadReqs(); }, [loadReqs]);

  const respond = async (r, yes) => {
    await supabase.from('task_flags').update({ response: yes ? 'yes' : 'no' }).eq('id', r.id);
    if (yes) {
      await supabase.from('task_assignees').insert({ task_id: r.task_id, user_id: uid });
      await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', r.task_id).eq('status', 'open');
      say('You are on this task now.');
    }
    loadReqs();
  };
  const hr = new Date().getHours();
  const next = events.find((e) => !e.starts_at || new Date(e.starts_at) >= new Date());
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <H t={`${hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'}, ${name}`} />
      {next ? (
        <Pressable onPress={() => go({ name: 'event', eid: next.id })} style={s.hero}>
          <Text style={s.heroSmall}>Up next · {fmt(next.starts_at)}</Text>
          <Text style={s.heroT}>{next.title}</Text>
          {next.place ? <Text style={s.heroSmall}>{next.place}</Text> : null}
        </Pressable>
      ) : <Card><Text style={s.mute}>No events yet. Create one or join with a code.</Text></Card>}
      {reqs.map((r) => (
        <Card key={r.id} style={{ backgroundColor: C.tint }}>
          <Text style={s.lock}>Only you can see this</Text>
          <Text style={s.bold}>{r.sender?.display_name || 'Someone'} could use a hand with “{r.tasks?.title}”</Text>
          {r.note ? <Text style={s.mute}>“{r.note}”</Text> : null}
          <View style={s.row}><Btn t="I can help" onPress={() => respond(r, true)} style={{ flex: 1 }} /><Btn t="Not this time" kind="ghost" onPress={() => respond(r, false)} style={{ flex: 1 }} /></View>
          <Text style={s.small}>If you say no, nobody else finds out.</Text>
        </Card>
      ))}
      <Text style={s.h2}>Your plans</Text>
      {events.map((e) => (
        <Pressable key={e.id} onPress={() => go({ name: 'event', eid: e.id })}><Card><Text style={s.bold}>{e.title}</Text><Text style={s.mute}>{fmt(e.starts_at)}{e.place ? ` · ${e.place}` : ''}</Text></Card></Pressable>
      ))}
      <View style={s.row}><Btn t="New event" onPress={() => go({ name: 'join' })} style={{ flex: 1 }} /><Btn t="Join with a code" kind="ghost" onPress={() => go({ name: 'join' })} style={{ flex: 1 }} /></View>
    </ScrollView>
  );
}

/* ---------- my tasks ---------- */
function Mine({ ctx, go }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    supabase.from('task_assignees').select('tasks(id, title, status, effort_size, event_id, events(title))').eq('user_id', ctx.uid)
      .then(({ data }) => setRows((data || []).map((r) => r.tasks).filter(Boolean).sort((a, b) => (a.status === 'done') - (b.status === 'done'))));
  }, []);
  if (!rows) return <Loading />;
  return (
    <ScrollView contentContainerStyle={s.pad}>
      <H t="My tasks" sub="Everything you have claimed, across events." />
      {rows.length === 0 ? <Card><Text style={s.mute}>Nothing yet. Claim a task from an event.</Text></Card> : null}
      {rows.map((t) => (
        <Pressable key={t.id} onPress={() => go({ name: 'task', eid: t.event_id, tid: t.id })}>
          <Card><Text style={[s.bold, t.status === 'done' && s.strike]}>{t.title}</Text><Text style={s.mute}>{t.events?.title} · {cap(t.effort_size)} · {cap(t.status.replace('_', ' '))}</Text></Card>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/* ---------- event: tasks / people / shared load ---------- */
function EventScreen({ ctx, eid, go }) {
  const ev = ctx.events.find((e) => e.id === eid);
  const { members, tasks, loaded, reload } = useEvent(eid);
  const [tab, setTab] = useState('tasks');
  const [adding, setAdding] = useState(false);
  if (!loaded || !ev) return <Loading />;
  const nameOf = (id) => members.find((m) => m.id === id)?.name || 'Guest';
  const covered = tasks.filter((t) => t.assignees.length || t.status === 'done').length;
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => go({ name: 'home' })}><Text style={s.back}>‹ Home</Text></Pressable>
        <H t={ev.title} sub={`${fmt(ev.starts_at)}${ev.place ? ` · ${ev.place}` : ''} · ${members.length} going`} />
        <View style={s.row}>{[['tasks', 'Tasks'], ['people', 'People'], ['load', 'Shared load']].map(([k, l]) => <Chip key={k} t={l} on={tab === k} onPress={() => setTab(k)} />)}</View>

        {tab === 'tasks' ? (<>
          <Text style={s.h2}>{covered} of {tasks.length} tasks covered</Text>
          {tasks.length === 0 ? <Card><Text style={s.mute}>No tasks yet. Add the first one and give it a size.</Text></Card> : null}
          {tasks.map((t) => (
            <Pressable key={t.id} onPress={() => go({ name: 'task', eid, tid: t.id })}>
              <Card style={s.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text style={[s.bold, t.status === 'done' && s.strike]}>{t.status === 'done' ? '✓ ' : ''}{t.title}</Text>
                  <Text style={s.mute}>{cap(t.status.replace('_', ' '))} · {cap(t.effort_size)}</Text>
                </View>
                <View style={s.row}>{t.assignees.map((a) => <Dot key={a} name={nameOf(a)} />)}</View>
              </Card>
            </Pressable>
          ))}
          <Btn t="+ Add a task" onPress={() => setAdding(true)} />
        </>) : null}

        {tab === 'people' ? (<>
          {members.map((m) => (
            <Card key={m.id} style={s.rowBetween}><View style={s.row}><Dot name={m.name} /><Text style={s.bold}>{m.name}{m.id === ctx.uid ? ' (you)' : ''}</Text></View>
              <Text style={s.mute}>{tasks.filter((t) => t.assignees.includes(m.id)).length} tasks</Text></Card>
          ))}
          <Card style={{ backgroundColor: C.tint }}>
            <Text style={s.bold}>Invite code: {ev.invite_code}</Text>
            <Text style={s.mute}>Share it, or send a link that fills it in.</Text>
            <Btn t="Share invite" onPress={() => Share.share({ message: `Join “${ev.title}” on Carry.\nLink: carry://join/${ev.invite_code}\nCode: ${ev.invite_code}` })} style={{ marginTop: 8 }} />
          </Card>
        </>) : null}

        {tab === 'load' ? <LoadTab ctx={ctx} eid={eid} members={members} tasks={tasks} reload={reload} go={go} /> : null}
      </ScrollView>
      <AddTask open={adding} onClose={() => setAdding(false)} ctx={ctx} eid={eid} members={members} reload={reload} />
    </View>
  );
}

function AddTask({ open, onClose, ctx, eid, members, reload }) {
  const [title, setTitle] = useState('');
  const [size, setSize] = useState('medium');
  const [who, setWho] = useState('open');
  const EX = { small: 'Under 30 minutes', medium: 'An hour or two', big: 'Half a day or more' };
  const save = async () => {
    const assignee = who === 'me' ? ctx.uid : who === 'open' ? null : who;
    const { data, error } = await supabase.from('tasks').insert({ event_id: eid, title: title.trim(), effort_size: size, status: assignee ? 'in_progress' : 'open', created_by: ctx.uid }).select().single();
    if (error) return Alert.alert('Could not add the task', error.message);
    if (assignee) await supabase.from('task_assignees').insert({ task_id: data.id, user_id: assignee });
    ctx.log('task_created', 'event', { effort_size: size, claimed: !!assignee });
    setTitle(''); setSize('medium'); setWho('open'); onClose(); reload();
  };
  return (
    <Sheet open={open} onClose={onClose}>
      <Text style={s.h2}>Add a task</Text>
      <TextInput style={s.input} value={title} onChangeText={setTitle} placeholder="Book the rooftop" />
      <Text style={s.label}>How big is it?</Text>
      <View style={s.row}>{SIZES.map((z) => <Chip key={z} t={cap(z)} on={size === z} onPress={() => setSize(z)} />)}</View>
      <Text style={s.small}>{cap(size)}: {EX[size]}</Text>
      <Text style={s.label}>Who takes it?</Text>
      <View style={[s.row, { flexWrap: 'wrap' }]}>
        <Chip t="Leave open" on={who === 'open'} onPress={() => setWho('open')} />
        <Chip t="Me" on={who === 'me'} onPress={() => setWho('me')} />
        {members.filter((m) => m.id !== ctx.uid).map((m) => <Chip key={m.id} t={m.name} on={who === m.id} onPress={() => setWho(m.id)} />)}
      </View>
      <Btn t="Add task" disabled={!title.trim()} onPress={save} style={{ marginTop: 16 }} />
      <Btn t="Cancel" kind="ghost" onPress={onClose} style={{ marginTop: 8 }} />
    </Sheet>
  );
}

function LoadTab({ ctx, eid, members, tasks, reload, go }) {
  const { uid, log } = ctx;
  const key = `nudge:${eid}`;
  const today = new Date().toDateString();
  const [ui, setUi] = useState('loading'); // loading | card | picked | declined | hidden
  const [picked, setPicked] = useState(null);
  const [detail, setDetail] = useState(false);
  const shown = useRef(false);

  useEffect(() => { log('balance_viewed', 'load'); AsyncStorage.getItem(key).then((v) => setUi(v === today ? 'hidden' : 'card')); }, []);
  const state = balanceState(members.map((m) => m.id), tasks);
  const cand = nudgeTasks(state, tasks);
  const showCard = ui === 'card' && cand.length > 0;
  useEffect(() => { if (showCard && !shown.current) { shown.current = true; log('nudge_shown', 'load'); } }, [showCard]);

  const pick = async (t) => {
    await supabase.from('task_assignees').insert({ task_id: t.id, user_id: uid });
    await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', t.id);
    setPicked(t.id); setUi('picked'); log('nudge_pick_up', 'load', { task_id: t.id }); reload();
  };
  const notNow = async () => { await AsyncStorage.setItem(key, today); setUi('declined'); log('nudge_not_now', 'load'); };
  const undo = async () => {
    if (ui === 'picked' && picked) {
      await supabase.from('task_assignees').delete().match({ task_id: picked, user_id: uid });
      await supabase.from('tasks').update({ status: 'open' }).eq('id', picked);
      reload();
    } else await AsyncStorage.removeItem(key);
    shown.current = false; setUi('card'); log('nudge_undo', 'load');
  };

  const L = loads(members.map((m) => m.id), tasks);
  const label = ui === 'picked' ? 'Getting more even' : LABEL[state];
  return (<>
    <H t="Shared load" sub="A gentle read on how the group is doing." />
    <Card><Text style={s.bold}>{label}</Text>
      <Text style={s.mute}>{state === 'balanced' ? 'The work looks well spread.' : 'There is room to spread the work.'}</Text></Card>
    <Card>
      <Text style={s.bold}>Who’s carrying what</Text>
      {detail ? (<>
        <Text style={s.mute}>Sorted A–Z. Everyone sees the same view.</Text>
        {members.map((m) => (
          <View key={m.id} style={{ marginTop: 8 }}>
            <Text style={s.bold}>{m.id === uid ? 'You' : m.name}</Text>
            <Text style={s.mute}>{['big', 'medium', 'small'].map((z) => `${L[m.id][z]} ${z}`).join(' · ')}</Text>
          </View>
        ))}
        <Btn t="Hide detailed view" kind="ghost" onPress={() => setDetail(false)} style={{ marginTop: 10 }} />
      </>) : (<>
        <Text style={s.mute}>The breakdown stays tucked away unless you want to see it.</Text>
        <Btn t="See a detailed view" kind="ghost" onPress={() => { setDetail(true); log('breakdown_opened', 'load'); }} style={{ marginTop: 8 }} />
      </>)}
    </Card>
    {showCard ? (
      <Card style={{ backgroundColor: C.tint }}>
        <Text style={s.lock}>Only you can see this</Text>
        <Text style={s.bold}>A few big tasks are still unclaimed. Want to take one?</Text>
        {cand.map((t) => <View key={t.id} style={[s.rowBetween, { marginTop: 8 }]}><Text style={[s.bold, { flex: 1 }]}>{t.title}</Text><Btn t="Pick up" onPress={() => pick(t)} /></View>)}
        <Btn t="Not now" kind="ghost" onPress={notNow} style={{ marginTop: 10 }} />
        <Text style={s.small}>Skipping hides this for today.</Text>
      </Card>
    ) : null}
    {ui === 'picked' ? (
      <Card style={{ backgroundColor: C.tint }}><Text style={s.bold}>Thanks, it’s yours now.</Text>
        <View style={s.row}><Btn t="See my tasks" onPress={() => go({ name: 'mine' })} style={{ flex: 1 }} /><Btn t="Undo" kind="ghost" onPress={undo} style={{ flex: 1 }} /></View></Card>
    ) : null}
    {ui === 'declined' ? (
      <Card style={{ backgroundColor: C.tint }}><Text style={s.bold}>Got it. No more suggestions today.</Text>
        <Btn t="Undo" kind="ghost" onPress={undo} style={{ marginTop: 8 }} /></Card>
    ) : null}
  </>);
}

/* ---------- task detail ---------- */
function TaskScreen({ ctx, eid, tid, go }) {
  const { uid, log, say } = ctx;
  const { members, tasks, loaded, reload } = useEvent(eid);
  const [sheet, setSheet] = useState(null); // rate | flag | ask
  const [rating, setRating] = useState(null);
  const [askId, setAskId] = useState(null);
  const [note, setNote] = useState('');
  const t = tasks.find((x) => x.id === tid);
  if (!loaded || !t) return <Loading />;

  const nameOf = (id) => members.find((m) => m.id === id)?.name || 'Guest';
  const mine = t.assignees.includes(uid);
  const others = members.filter((m) => m.id !== uid);
  const run = async (p) => { const { error } = await p; if (error) { Alert.alert('Something went wrong', error.message); return false; } return true; };
  const setStatus = (status) => run(supabase.from('tasks').update({ status }).eq('id', t.id));

  const claim = async () => { if (await run(supabase.from('task_assignees').insert({ task_id: t.id, user_id: uid }))) { if (t.status === 'open') await setStatus('in_progress'); reload(); } };
  const leave = async () => { await run(supabase.from('task_assignees').delete().match({ task_id: t.id, user_id: uid })); if (t.assignees.length <= 1 && t.status === 'in_progress') await setStatus('open'); reload(); };
  const done = async () => { if (await setStatus('done')) { setRating(null); setSheet('rate'); log('rating_started', 'task', { task_id: t.id }); reload(); } };
  const reopen = async () => { await setStatus('in_progress'); reload(); };

  const next = rating ? bump(t.effort_size, rating) : t.effort_size;
  const preview = !rating ? 'Pick one. It only updates the task’s size.'
    : next === t.effort_size ? `${cap(rating)} than expected · size stays ${cap(t.effort_size)}`.replace('Expected than expected', 'As expected')
    : `${cap(rating)} than expected · size goes from ${cap(t.effort_size)} to ${cap(next)}`;
  const save = async () => {
    if (!(await run(supabase.from('effort_ratings').upsert({ task_id: t.id, user_id: uid, rating })))) return;
    await run(supabase.from('tasks').update({ effort_size: next }).eq('id', t.id));
    log('rating_saved', 'task', { task_id: t.id, rating }); setSheet(null); say('Effort saved. Thanks for keeping it fair.'); reload();
  };

  const openFlag = () => { setSheet('flag'); log('flag_opened', 'task', { task_id: t.id }); };
  const chosen = (action) => { log('flag_chosen', 'task', { task_id: t.id, action }); setSheet(null); setNote(''); setAskId(null); reload(); };
  const ask = async () => {
    if (await run(supabase.from('task_flags').insert({ task_id: t.id, user_id: uid, action: 'ask_for_hand', asked_user_id: askId, note: note.trim() || null }))) {
      say(`Asked ${nameOf(askId)} privately.`); chosen('ask_for_hand');
    }
  };
  const split = async () => {
    if (await run(supabase.from('task_flags').insert({ task_id: t.id, user_id: uid, action: 'split' })) &&
        await run(supabase.from('tasks').insert({ event_id: eid, title: `${t.title} (part 2)`, effort_size: t.effort_size, status: 'open', created_by: uid }))) {
      say('Split into two. The second part is open for anyone.'); chosen('split');
    }
  };
  const justFlag = async () => {
    if (await run(supabase.from('task_flags').insert({ task_id: t.id, user_id: uid, action: 'just_flag' }))) {
      await run(supabase.from('tasks').update({ effort_size: bump(t.effort_size, 'more') }).eq('id', t.id));
      say('Flagged. The size went up one step.'); chosen('just_flag');
    }
  };

  const Opt = ({ title, sub, onPress }) => (<Pressable onPress={onPress} style={s.opt}><Text style={s.bold}>{title}</Text><Text style={s.mute}>{sub}</Text></Pressable>);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.pad}>
        <Pressable onPress={() => go({ name: 'event', eid })}><Text style={s.back}>‹ Back</Text></Pressable>
        <H t={t.title} sub={`${cap(t.effort_size)} · ${cap(t.status.replace('_', ' '))}`} />
        <Card>
          <Text style={s.bold}>{t.assignees.length ? `${t.assignees.map(nameOf).join(' and ')} on this` : 'Nobody has claimed this yet'}</Text>
        </Card>
        {t.status !== 'done' ? (<>
          <Pressable onPress={openFlag} style={s.warnBox}><Text style={{ color: C.warnInk }}>↗ This is bigger than expected</Text></Pressable>
          {mine ? <Btn t="Mark done" onPress={done} /> : <Btn t="Pick up this task" onPress={claim} />}
          {mine ? <Btn t="Leave this task" kind="ghost" onPress={leave} style={{ marginTop: 8 }} /> : null}
        </>) : <Btn t="Reopen" kind="ghost" onPress={reopen} />}
      </ScrollView>

      <Sheet open={sheet === 'rate'} onClose={() => setSheet(null)}>
        <Text style={s.h2}>How much effort did this take?</Text>
        <Text style={s.mute}>A quick check helps keep the group’s view fair.</Text>
        <View style={[s.row, { marginVertical: 12 }]}>{['less', 'expected', 'more'].map((r) => <Chip key={r} t={cap(r)} on={rating === r} onPress={() => setRating(r)} />)}</View>
        <Text style={s.small}>{preview}</Text>
        <Btn t="Save effort rating" disabled={!rating} onPress={save} style={{ marginTop: 14 }} />
        <Btn t="Skip for now" kind="ghost" onPress={() => setSheet(null)} style={{ marginTop: 8 }} />
      </Sheet>

      <Sheet open={sheet === 'flag'} onClose={() => setSheet(null)}>
        <Text style={s.h2}>This is bigger than expected</Text>
        <Text style={s.mute}>{t.title}. What would help most?</Text>
        <Opt title="I could use a hand" sub="Pick someone and ask them privately." onPress={() => { setSheet('ask'); }} />
        <Opt title="Split this into two tasks" sub="Keep your part. The rest opens up for anyone to claim." onPress={split} />
        <Opt title="Just flagging it" sub="Bumps the size by one step. Nobody is asked to do anything." onPress={justFlag} />
        <Text style={s.small}>Only you see this unless you choose to ask the group.</Text>
        <Btn t="Cancel" kind="ghost" onPress={() => setSheet(null)} style={{ marginTop: 8 }} />
      </Sheet>

      <Sheet open={sheet === 'ask'} onClose={() => setSheet(null)}>
        <Pressable onPress={() => setSheet('flag')}><Text style={s.back}>‹ Options</Text></Pressable>
        <Text style={s.h2}>Who could lend a hand?</Text>
        {others.length === 0 ? <Text style={s.mute}>Nobody else has joined yet. Share the invite code first.</Text> : null}
        {others.map((m) => <Chip key={m.id} t={m.name} on={askId === m.id} onPress={() => setAskId(m.id)} />)}
        <Text style={s.label}>Add a note (optional)</Text>
        <TextInput style={s.input} value={note} onChangeText={setNote} multiline placeholder="Could you take the shopping list part?" />
        <Btn t={askId ? `Ask ${nameOf(askId)} privately` : 'Choose someone'} disabled={!askId} onPress={ask} style={{ marginTop: 12 }} />
        <Text style={s.small}>Only you and the person you ask see this. If they say no, nobody else finds out.</Text>
      </Sheet>
    </View>
  );
}

/* ---------- styles ---------- */
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 18, paddingBottom: 40, gap: 10 }, row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  h1: { fontSize: 28, fontWeight: '700', color: C.ink }, h2: { fontSize: 18, fontWeight: '700', color: C.ink, marginTop: 6 },
  bold: { fontSize: 15, fontWeight: '600', color: C.ink }, mute: { fontSize: 13, color: C.mute }, small: { fontSize: 12, color: C.mute, marginTop: 6 },
  label: { fontSize: 13, color: C.mute, marginTop: 12, marginBottom: 4 }, strike: { textDecorationLine: 'line-through', color: C.mute },
  back: { color: C.green, fontSize: 15, marginBottom: 6 }, lock: { color: C.green, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 14, gap: 4, borderWidth: 1, borderColor: C.line },
  hero: { backgroundColor: C.dark, borderRadius: 18, padding: 18, gap: 4 }, heroT: { color: '#fff', fontSize: 24, fontWeight: '700' }, heroSmall: { color: '#BFE0CE', fontSize: 13 },
  btn: { backgroundColor: C.green, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center' }, btnT: { color: '#fff', fontWeight: '600', fontSize: 15 },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.green },
  chip: { borderWidth: 1, borderColor: C.line, backgroundColor: '#fff', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 14, marginVertical: 3 },
  chipOn: { backgroundColor: C.green, borderColor: C.green }, chipT: { color: C.ink, fontWeight: '500' },
  dot: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#7FAE92', alignItems: 'center', justifyContent: 'center' }, dotT: { color: '#fff', fontWeight: '700' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 12, fontSize: 15, color: C.ink },
  warnBox: { backgroundColor: C.warn, borderRadius: 10, padding: 12 },
  opt: { backgroundColor: C.bg, borderRadius: 12, padding: 14, marginTop: 10, gap: 2 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, maxHeight: '85%' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: '#fff' }, tab: { flex: 1, alignItems: 'center', padding: 14 }, tabT: { color: C.mute },
  toast: { position: 'absolute', bottom: 80, alignSelf: 'center', backgroundColor: C.ink, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 16 },
});
