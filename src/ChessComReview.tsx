import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Chessboard, type Arrow } from 'react-chessboard';
import {
  reviewGameAgainstRepertoire,
  type GameRepertoireReview,
  type GameRepertoireReviewStatus,
  type ReviewedGameMove,
} from '../shared/game-review.js';
import { getCachedRepertoires, getChessComGames, isApiError } from './api.js';
import {
  CHESSCOM_TIME_CLASSES,
  filterChessComGames,
  formatGameDate,
  normalizeChessComUsername,
  plyLabel,
  timeClassLabel,
  type ChessComTimeClass,
} from './chesscom-review-view.js';
import { disposeLocalEngine, evaluateLocalMove } from './local-engine.js';
import type { ChessComGame, ChessComGamesPayload, OpeningMoveEvaluation } from './types.js';

const DEFAULT_USERNAME = 'Yshaarrj';
const USERNAME_STORAGE_KEY = 'opening-room.chesscom-username';
const ALL_TIME_CLASSES = new Set<ChessComTimeClass>(CHESSCOM_TIME_CLASSES);

interface ReviewedEntry {
  game: ChessComGame;
  review: GameRepertoireReview;
}

type EngineCheck =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; result: OpeningMoveEvaluation }
  | { status: 'error'; message: string };

function storedUsername(): string {
  try {
    return normalizeChessComUsername(window.localStorage.getItem(USERNAME_STORAGE_KEY) ?? '') || DEFAULT_USERNAME;
  } catch {
    return DEFAULT_USERNAME;
  }
}

function statusCopy(status: GameRepertoireReviewStatus): { label: string; tone: string; short: string } {
  switch (status) {
    case 'user-deviation':
      return { label: '레퍼토리 이탈', tone: 'coral', short: '내가 준비한 수와 처음 달라졌어요.' };
    case 'opponent-uncovered':
      return { label: '상대의 새 수', tone: 'gold', short: '상대 수에서 연구 범위가 끝났어요.' };
    case 'in-repertoire':
      return { label: '레퍼토리 안', tone: 'aqua', short: '확인된 모든 수가 준비 범위 안이에요.' };
    case 'coverage-ended':
      return { label: '연구 범위 종료', tone: 'muted', short: '준비한 라인을 모두 지난 뒤의 수라서 정답·오답으로 평가하지 않았어요.' };
    default:
      return { label: '대조 대상 없음', tone: 'muted', short: '색상과 첫 수가 맞는 연구를 찾지 못했어요.' };
  }
}

function resultCopy(result: GameRepertoireReview['meta']['result']): string {
  if (result === 'win') return '승';
  if (result === 'draw') return '무';
  if (result === 'loss') return '패';
  return '—';
}

function friendlyError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 404) return 'Chess.com에서 이 사용자를 찾지 못했습니다. 철자와 공개 프로필을 확인해 주세요.';
    if (error.status === 429 || error.code === 'chesscom_rate_limited') return 'Chess.com 요청이 잠시 제한됐습니다. 잠깐 뒤 다시 시도해 주세요.';
    if (error.status === 502 || error.status === 503) return 'Chess.com 응답이 늦고 있습니다. 잠시 뒤 다시 불러와 주세요.';
  }
  return error instanceof Error ? error.message : '최근 대국을 불러오지 못했습니다.';
}

function toReviewInput(game: ChessComGame) {
  return {
    id: game.id,
    pgn: game.pgn,
    url: game.url,
    playedAt: new Date(game.endTime * 1000).toISOString(),
    timeClass: game.timeClass,
    timeControl: game.timeControl,
    rated: game.rated,
    rules: game.rules,
    white: game.white,
    black: game.black,
  };
}

function initialCursor(review: GameRepertoireReview): number {
  if (review.firstDeviation) return Math.max(0, review.firstDeviation.ply - 1);
  return Math.min(review.matchedPlies, review.moves.length);
}

function uciArrow(uci: string, color: string): Arrow | undefined {
  if (!/^[a-h][1-8][a-h][1-8]/i.test(uci)) return undefined;
  return { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color };
}

function playerLine(entry: ReviewedEntry): string {
  const { review } = entry;
  const rating = review.meta.opponent.rating ? ` ${review.meta.opponent.rating}` : '';
  return `${review.meta.userColor === 'white' ? '백' : '흑'} · vs ${review.meta.opponent.username}${rating}`;
}

function ReviewMoveSheet({ review, cursor, onSeek }: {
  review: GameRepertoireReview;
  cursor: number;
  onSeek: (ply: number) => void;
}) {
  const rows = useMemo(() => Array.from({ length: Math.ceil(review.moves.length / 2) }, (_, index) => ({
    number: index + 1,
    white: review.moves[index * 2],
    black: review.moves[index * 2 + 1],
  })), [review.moves]);

  const moveClass = (move: ReviewedGameMove | undefined) => {
    if (!move) return 'review-move is-empty';
    const classes = ['review-move'];
    if (move.ply === cursor) classes.push('is-current');
    if (move.ply <= review.matchedPlies) classes.push('is-matched');
    if (move.ply === review.firstDeviation?.ply) {
      classes.push(review.status === 'coverage-ended' ? 'is-coverage-ended' : 'is-deviation');
    }
    return classes.join(' ');
  };

  return (
    <div className="review-move-sheet">
      {rows.length === 0 && <p className="review-placeholder">기록된 수가 없습니다.</p>}
      {rows.map(({ number, white, black }) => (
        <div className="review-move-row" key={number}>
          <span>{number}.</span>
          {white ? <button type="button" className={moveClass(white)} onClick={() => onSeek(white.ply)}>{white.san}</button> : <i />}
          {black ? <button type="button" className={moveClass(black)} onClick={() => onSeek(black.ply)}>{black.san}</button> : <i />}
        </div>
      ))}
    </div>
  );
}

function EngineResult({ state }: { state: EngineCheck }) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') return <div className="review-engine-result is-loading" role="status"><span className="review-spinner" />Stockfish가 이 수만 확인하고 있어요…</div>;
  if (state.status === 'error') return <div className="review-engine-result is-error" role="alert"><strong>엔진 확인 실패</strong><span>{state.message}</span></div>;
  if (state.result.status === 'unavailable') {
    return <div className="review-engine-result is-error"><strong>평가할 수 없음</strong><span>이 브라우저에서 엔진 분석을 완료하지 못했습니다.</span></div>;
  }
  const passed = state.result.passed;
  const best = state.result.bestMoves.slice(0, 3).map((move) => move.san ?? move.uci).join(' · ');
  return (
    <div className={`review-engine-result ${passed ? 'is-pass' : 'is-fail'}`} role="status">
      <strong>{passed ? '건전한 대안' : '손실이 큰 수'}</strong>
      <span>손실 {(state.result.centipawnLoss / 100).toFixed(2)}폰 · 허용 {(state.result.thresholdCp / 100).toFixed(2)}폰</span>
      {best && <small>엔진 후보: {best}</small>}
    </div>
  );
}

export default function ChessComReview({ onBack }: { onBack: () => void }) {
  const [username, setUsername] = useState(storedUsername);
  const [submittedUsername, setSubmittedUsername] = useState(storedUsername);
  const [months, setMonths] = useState(3);
  const [reload, setReload] = useState(0);
  const [payload, setPayload] = useState<ChessComGamesPayload | null>(null);
  const [entries, setEntries] = useState<ReviewedEntry[]>([]);
  const [skippedGames, setSkippedGames] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cacheMissing, setCacheMissing] = useState(false);
  const [selectedClasses, setSelectedClasses] = useState<Set<ChessComTimeClass>>(() => new Set(ALL_TIME_CLASSES));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [engineCheck, setEngineCheck] = useState<EngineCheck>({ status: 'idle' });
  const engineAbort = useRef<AbortController | null>(null);
  const engineWasUsed = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setCacheMissing(false);
    setPayload(null);
    setEntries([]);
    setSelectedId(null);

    void Promise.all([
      getChessComGames(submittedUsername, months),
      getCachedRepertoires(),
    ]).then(([gamesPayload, studies]) => {
      if (!active) return;
      setPayload(gamesPayload);
      if (studies.length === 0) {
        setCacheMissing(true);
        setLoading(false);
        return;
      }

      const reviewed: ReviewedEntry[] = [];
      let skipped = 0;
      for (const game of gamesPayload.games) {
        try {
          reviewed.push({
            game,
            review: reviewGameAgainstRepertoire(toReviewInput(game), gamesPayload.username, studies),
          });
        } catch {
          skipped += 1;
        }
      }
      setSkippedGames(skipped);
      setEntries(reviewed);
      setSelectedId(reviewed[0]?.game.id ?? null);
      setLoading(false);
      try { window.localStorage.setItem(USERNAME_STORAGE_KEY, gamesPayload.username); } catch { /* storage is optional */ }
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadError(friendlyError(error));
      setLoading(false);
    });

    return () => { active = false; };
  }, [months, reload, submittedUsername]);

  const visibleEntries = useMemo(() => {
    const allowedGames = new Set(filterChessComGames(entries.map((entry) => entry.game), selectedClasses).map((game) => game.id));
    return entries.filter((entry) => allowedGames.has(entry.game.id));
  }, [entries, selectedClasses]);

  const selected = useMemo(
    () => visibleEntries.find((entry) => entry.game.id === selectedId) ?? visibleEntries[0],
    [selectedId, visibleEntries],
  );

  useEffect(() => {
    if (selected && selected.game.id !== selectedId) setSelectedId(selected.game.id);
    if (!selected && selectedId !== null) setSelectedId(null);
  }, [selected, selectedId]);

  useEffect(() => {
    engineAbort.current?.abort();
    engineAbort.current = null;
    setEngineCheck({ status: 'idle' });
    setCursor(selected ? initialCursor(selected.review) : 0);
  }, [selected?.game.id]);

  useEffect(() => () => {
    engineAbort.current?.abort();
    if (engineWasUsed.current) disposeLocalEngine();
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeChessComUsername(username);
    if (!normalized) {
      setLoadError('Chess.com 사용자명을 입력해 주세요.');
      return;
    }
    setUsername(normalized);
    if (normalized === submittedUsername) setReload((value) => value + 1);
    else setSubmittedUsername(normalized);
  };

  const toggleTimeClass = (timeClass: ChessComTimeClass) => {
    setSelectedClasses((current) => {
      const next = new Set(current);
      if (next.has(timeClass)) {
        if (next.size === 1) return current;
        next.delete(timeClass);
      } else next.add(timeClass);
      return next;
    });
  };

  const handleEngineCheck = useCallback(async () => {
    const deviation = selected?.review.firstUserDeviation;
    if (!deviation || engineCheck.status === 'loading') return;
    engineAbort.current?.abort();
    const controller = new AbortController();
    engineAbort.current = controller;
    engineWasUsed.current = true;
    setEngineCheck({ status: 'loading' });
    try {
      const result = await evaluateLocalMove({
        fen: deviation.beforeFen,
        uci: deviation.played.uci,
        san: deviation.played.san,
      }, { maxCpl: 80, signal: controller.signal });
      if (!controller.signal.aborted) setEngineCheck({ status: 'done', result });
    } catch (error) {
      if (!controller.signal.aborted) {
        setEngineCheck({ status: 'error', message: error instanceof Error ? error.message : '로컬 엔진을 시작하지 못했습니다.' });
      }
    }
  }, [engineCheck.status, selected]);

  const counts = useMemo(() => ({
    deviation: visibleEntries.filter((entry) => entry.review.status === 'user-deviation').length,
    covered: visibleEntries.filter((entry) => entry.review.status === 'in-repertoire').length,
    newMove: visibleEntries.filter((entry) => entry.review.status === 'opponent-uncovered').length,
    coverageEnded: visibleEntries.filter((entry) => entry.review.status === 'coverage-ended').length,
  }), [visibleEntries]);

  const boardFen = selected
    ? cursor <= 0 ? selected.review.initialFen : selected.review.moves[Math.min(cursor, selected.review.moves.length) - 1]?.afterFen ?? selected.review.initialFen
    : 'start';
  const deviation = selected?.review.firstDeviation;
  const isBeforeDeviation = Boolean(deviation && cursor === deviation.ply - 1);
  const arrows = useMemo(() => {
    if (!deviation || !isBeforeDeviation) return [];
    const expected = deviation.expectedMoves.slice(0, 3)
      .map((move) => uciArrow(move.uci, '#4fcbb2'))
      .filter((arrow): arrow is Arrow => Boolean(arrow));
    const played = uciArrow(deviation.played.uci, selected?.review.status === 'coverage-ended' ? '#8e9daf' : '#ed695d');
    return played ? [...expected, played] : expected;
  }, [deviation, isBeforeDeviation, selected?.review.status]);
  const squareStyles = useMemo(() => {
    if (!deviation || !isBeforeDeviation) return {};
    const styles: Record<string, CSSProperties> = {};
    for (const expected of deviation.expectedMoves.slice(0, 3)) {
      styles[expected.uci.slice(2, 4)] = { boxShadow: 'inset 0 0 0 5px rgba(79,203,178,.68)' };
    }
    styles[deviation.played.uci.slice(2, 4)] = {
      boxShadow: selected?.review.status === 'coverage-ended'
        ? 'inset 0 0 0 5px rgba(142,157,175,.72)'
        : 'inset 0 0 0 5px rgba(237,105,93,.78)',
    };
    return styles;
  }, [deviation, isBeforeDeviation, selected?.review.status]);

  return (
    <main className="review-shell">
      <header className="review-topbar">
        <button className="back-button" type="button" onClick={onBack}><span aria-hidden="true">←</span> 라이브러리</button>
        <div className="review-title"><small>CHESS.COM GAME REVIEW</small><strong>실전 레퍼토리 복기</strong></div>
        <a className="review-profile-link" href={`https://www.chess.com/member/${encodeURIComponent(submittedUsername)}`} target="_blank" rel="noreferrer">Chess.com 프로필 ↗</a>
      </header>

      <section className="review-control-card">
        <form className="review-account-form" onSubmit={handleSubmit}>
          <label htmlFor="chesscom-username"><span>Chess.com 사용자명</span><input id="chesscom-username" value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} autoCapitalize="none" /></label>
          <label htmlFor="chesscom-months"><span>불러올 기간</span><select id="chesscom-months" value={months} onChange={(event) => setMonths(Number(event.target.value))}><option value={1}>최근 1개월</option><option value={3}>최근 3개월</option><option value={6}>최근 6개월</option><option value={12}>최근 12개월</option></select></label>
          <button className="button button-primary" type="submit" disabled={loading}>{loading ? '분석 중…' : '최근 대국 불러오기'}</button>
        </form>
        <div className="review-speed-filter" aria-label="시간 형식 필터">
          <span>시간 형식</span>
          {CHESSCOM_TIME_CLASSES.map((timeClass) => <button key={timeClass} type="button" className={selectedClasses.has(timeClass) ? 'is-selected' : ''} aria-pressed={selectedClasses.has(timeClass)} onClick={() => toggleTimeClass(timeClass)}>{timeClassLabel(timeClass)}</button>)}
        </div>
      </section>

      {loading && <section className="review-state-card" aria-live="polite"><span className="review-spinner" /><h2>최근 대국을 레퍼토리와 맞추는 중</h2><p>Chess.com 공개 기록과 이 기기에 동기화된 Lichess 연구를 읽고 있어요.</p></section>}

      {!loading && loadError && <section className="review-state-card is-error" role="alert"><span className="review-state-symbol">!</span><h2>대국을 불러오지 못했습니다</h2><p>{loadError}</p><button className="button button-secondary" type="button" onClick={() => setReload((value) => value + 1)}>다시 시도</button></section>}

      {!loading && !loadError && cacheMissing && <section className="review-state-card is-warning"><span className="review-state-symbol">♙</span><h2>먼저 Lichess 연구를 동기화해 주세요</h2><p>실전 수와 대조할 서버 캐시가 비어 있습니다. 라이브러리에서 연구를 한 번 동기화한 뒤 돌아오세요.</p><button className="button button-secondary" type="button" onClick={onBack}>라이브러리로 돌아가기</button></section>}

      {!loading && !loadError && !cacheMissing && entries.length === 0 && <section className="review-state-card"><span className="review-state-symbol">♟</span><h2>분석할 공개 대국이 없습니다</h2><p>선택한 기간에 표준 체스 대국이 없거나 PGN을 읽을 수 없었습니다.</p></section>}

      {!loading && !loadError && !cacheMissing && entries.length > 0 && (
        <>
          <section className="review-summary" aria-live="polite">
            <div><small>필터 결과</small><strong>{visibleEntries.length}<span>국</span></strong></div>
            <div className="is-coral"><small>레퍼토리 이탈</small><strong>{counts.deviation}</strong></div>
            <div className="is-gold"><small>상대의 새 수</small><strong>{counts.newMove}</strong></div>
            <div className="is-muted"><small>연구 범위 종료</small><strong>{counts.coverageEnded}</strong></div>
            <div className="is-aqua"><small>레퍼토리 안</small><strong>{counts.covered}</strong></div>
            <p>{payload?.archivesChecked ?? 0}개 월별 기록 확인{skippedGames ? ` · 읽지 못한 대국 ${skippedGames}개 제외` : ''}</p>
          </section>

          {visibleEntries.length === 0 ? <section className="review-state-card is-compact"><h2>선택한 시간 형식의 대국이 없습니다</h2><p>위 필터에서 다른 시간 형식을 선택해 보세요.</p></section> : (
            <div className="review-workspace">
              <aside className="review-game-list" aria-label="분석 결과 목록">
                <div className="review-pane-heading"><span>최근 대국</span><small>첫 이탈 기준</small></div>
                <div className="review-game-scroll">
                  {visibleEntries.map((entry) => {
                    const copy = statusCopy(entry.review.status);
                    const selectedGame = entry.game.id === selected?.game.id;
                    return <button className={`review-game-card ${selectedGame ? 'is-selected' : ''}`} type="button" key={entry.game.id} onClick={() => setSelectedId(entry.game.id)} aria-pressed={selectedGame}>
                      <span className="review-game-card-top"><b className={`review-result is-${entry.review.meta.result}`}>{resultCopy(entry.review.meta.result)}</b><time>{formatGameDate(entry.game.endTime)}</time><i>{timeClassLabel(entry.game.timeClass)}</i></span>
                      <strong>{playerLine(entry)}</strong>
                      <span className={`review-status-badge is-${copy.tone}`}>{copy.label}{entry.review.firstDeviation ? ` · ${plyLabel(entry.review.firstDeviation.ply)} ${entry.review.firstDeviation.played.san}` : ''}</span>
                    </button>;
                  })}
                </div>
              </aside>

              {selected && <section className="review-board-pane">
                <div className="review-board-heading">
                  <div><span>{selected.review.meta.userColor === 'white' ? '백' : '흑'} · {resultCopy(selected.review.meta.result)}</span><strong>{selected.review.meta.user.username} vs {selected.review.meta.opponent.username}</strong></div>
                  <a href={selected.game.url} target="_blank" rel="noreferrer">Chess.com에서 보기 ↗</a>
                </div>
                <div className="review-board-frame"><Chessboard options={{
                  id: `review-${selected.game.id}`,
                  position: boardFen,
                  boardOrientation: selected.review.meta.userColor,
                  allowDragging: false,
                  allowDrawingArrows: false,
                  showNotation: true,
                  showAnimations: true,
                  animationDurationInMs: 220,
                  arrows,
                  squareStyles,
                  darkSquareStyle: { backgroundColor: '#567577' },
                  lightSquareStyle: { backgroundColor: '#d9ded3' },
                  boardStyle: { borderRadius: '7px', boxShadow: '0 20px 50px rgba(0,0,0,.28)' },
                }} /></div>
                <div className="review-board-nav">
                  <button type="button" onClick={() => setCursor(0)} disabled={cursor === 0} aria-label="처음 위치">|‹</button>
                  <button type="button" onClick={() => setCursor((value) => Math.max(0, value - 1))} disabled={cursor === 0} aria-label="이전 수">‹</button>
                  <span>{cursor === 0 ? '시작 위치' : `${plyLabel(cursor)} ${selected.review.moves[cursor - 1]?.san ?? ''}`}<small>{cursor} / {selected.review.moves.length}</small></span>
                  <button type="button" onClick={() => setCursor((value) => Math.min(selected.review.moves.length, value + 1))} disabled={cursor >= selected.review.moves.length} aria-label="다음 수">›</button>
                  <button type="button" onClick={() => setCursor(selected.review.moves.length)} disabled={cursor >= selected.review.moves.length} aria-label="마지막 위치">›|</button>
                </div>
                {deviation && !isBeforeDeviation && <button className={`review-jump-button ${selected.review.status === 'coverage-ended' ? 'is-neutral' : ''}`} type="button" onClick={() => setCursor(deviation.ply - 1)}>{selected.review.status === 'coverage-ended' ? '연구가 끝난 지점으로 이동' : '첫 이탈 직전으로 이동'}</button>}
              </section>}

              {selected && <aside className="review-detail-pane">
                <div className="review-pane-heading"><span>대국 상세</span><small>{selected.review.meta.opening ?? selected.review.meta.eco ?? 'Opening review'}</small></div>
                <div className="review-detail-scroll">
                  <ReviewMoveSheet review={selected.review} cursor={cursor} onSeek={setCursor} />
                  <div className={`review-finding is-${statusCopy(selected.review.status).tone}`}>
                    <span>{statusCopy(selected.review.status).label}</span>
                    <h2>{deviation ? `${plyLabel(deviation.ply)} ${deviation.played.san}` : statusCopy(selected.review.status).label}</h2>
                    <p>{statusCopy(selected.review.status).short}</p>
                    {deviation?.kind === 'opponent-uncovered' && <small>내 수의 오류가 아니라 상대의 수에서 현재 연구 범위가 끝난 것입니다.</small>}
                    {deviation?.kind === 'user-deviation' && deviation.reason === 'known-avoid' && <small>연구에서 피해야 할 수로 표시해 둔 선택입니다.</small>}
                    {deviation?.kind === 'coverage-ended' && <small>이 다음 수부터는 연구에 정답이 없으므로, 둔 수의 좋고 나쁨을 판정하지 않습니다.</small>}
                  </div>

                  {deviation?.kind === 'user-deviation' && <div className="review-expected">
                    <div><span>내가 둔 수</span><strong className="is-played">{deviation.played.san}</strong></div>
                    <div><span>준비한 대응</span><p>{deviation.expectedMoves.length ? deviation.expectedMoves.map((move) => <button key={move.moveId} type="button" onClick={() => setCursor(deviation.ply - 1)} title="보드에서 화살표 보기">{move.san}</button>) : <em>연구 라인 종료</em>}</p></div>
                    {deviation.expectedMoves.flatMap((move) => move.annotations.comments).slice(0, 2).map((comment, index) => <blockquote key={`${index}:${comment}`}>{comment}</blockquote>)}
                  </div>}

                  {selected.review.match && <div className="review-match-card"><span>가장 오래 일치한 챕터</span><strong>{selected.review.match.studyName ?? 'Lichess 연구'} · {selected.review.match.chapterName}</strong><small>{selected.review.matchedPlies}플라이 · 내 수 {selected.review.matchedUserMoves}회 일치</small>{selected.review.match.sourceUrl && <a href={selected.review.match.sourceUrl} target="_blank" rel="noreferrer">Lichess 연구 열기 ↗</a>}</div>}

                  {selected.review.firstUserDeviation && <div className="review-engine-card">
                    <span>레퍼토리 밖이어도 좋은 수였을까요?</span>
                    <p>선택한 이탈 수 하나만 로컬 Stockfish로 확인합니다. 레퍼토리 일치 여부와 엔진 평가는 별개예요.</p>
                    <button className="button button-secondary" type="button" disabled={engineCheck.status === 'loading'} onClick={() => void handleEngineCheck()}>{engineCheck.status === 'loading' ? '확인 중…' : engineCheck.status === 'done' ? '다시 확인' : '엔진으로 확인'}</button>
                    <EngineResult state={engineCheck} />
                  </div>}
                </div>
              </aside>}
            </div>
          )}
        </>
      )}
    </main>
  );
}
