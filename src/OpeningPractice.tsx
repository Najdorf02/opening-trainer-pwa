import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Color, type Square } from 'chess.js';
import { Chessboard, type Arrow } from 'react-chessboard';
import {
  decideOpponentMoveSource,
  gameCount,
  selectOpponentMove,
  type OpeningPracticeSourceMode,
} from '../shared/opening-practice.js';
import { evaluateOpeningMove, getOpeningExplorer } from './api';
import { disposeLocalEngine, evaluateLocalMove, suggestLocalMove } from './local-engine';
import type {
  OpeningExplorerFilters,
  OpeningExplorerPayload,
  OpeningMoveEvaluation,
  Orientation,
} from './types';

type SideChoice = Orientation | 'random';
type RatingBand = '1600' | '2000';
type PracticePhase =
  | 'setup'
  | 'opponent-loading'
  | 'user-loading'
  | 'awaiting'
  | 'grading'
  | 'retry'
  | 'accepted'
  | 'error'
  | 'complete';

interface PlayedMove {
  uci: string;
  san: string;
  color: Color;
}

interface PendingMove {
  uci: string;
  san: string;
  fenAfter: string;
}

type OpponentChoiceInfo =
  | { source: 'database'; san: string; games: number; probability: number }
  | { source: 'local-engine'; san: string; depth: number };

const INITIAL_FEN = new Chess().fen();
const SPEEDS: OpeningExplorerFilters['speeds'] = ['blitz', 'rapid', 'classical'];

function applyUci(game: Chess, uci: string) {
  return game.move({
    from: uci.slice(0, 2) as Square,
    to: uci.slice(2, 4) as Square,
    ...(uci[4] ? { promotion: uci[4] } : {}),
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function moveRows(history: PlayedMove[]): Array<{ number: number; white?: PlayedMove; black?: PlayedMove }> {
  const rows: Array<{ number: number; white?: PlayedMove; black?: PlayedMove }> = [];
  history.forEach((move, index) => {
    const number = Math.floor(index / 2) + 1;
    const row = rows[number - 1] ?? { number };
    if (move.color === 'w') row.white = move;
    else row.black = move;
    rows[number - 1] = row;
  });
  return rows;
}

function reasonText(evaluation: OpeningMoveEvaluation | null): { title: string; detail: string } {
  if (!evaluation) return { title: '건전한 대응입니다', detail: '다음 포지션으로 넘어갑니다.' };
  if (evaluation.status === 'unavailable') {
    return {
      title: '평가 자료 없음 · 통과',
      detail: '캐시된 엔진 평가가 없어 오답 처리하지 않고 계속합니다.',
    };
  }
  if (evaluation.verdict === 'fail') {
    if (evaluation.reason === 'engine-forced-mate-lost') {
      return { title: '강제 메이트를 놓쳤어요', detail: '추천 화살표를 참고해 다른 수를 직접 두세요.' };
    }
    return {
      title: `평가 손실 ${(evaluation.centipawnLoss / 100).toFixed(2)}폰`,
      detail: `허용 범위 ${(evaluation.thresholdCp / 100).toFixed(2)}폰 안의 다른 수를 찾아보세요.`,
    };
  }
  return {
    title: `건전한 대응 · 손실 ${(evaluation.centipawnLoss / 100).toFixed(2)}폰`,
    detail: `허용 범위 ${(evaluation.thresholdCp / 100).toFixed(2)}폰 안입니다.`,
  };
}

export default function OpeningPractice({
  onBack,
  lichessConnected,
}: {
  onBack: () => void;
  lichessConnected: boolean;
}) {
  const [sideChoice, setSideChoice] = useState<SideChoice>('random');
  const [sourceMode, setSourceMode] = useState<OpeningPracticeSourceMode>('auto');
  const [ratingBand, setRatingBand] = useState<RatingBand>('1600');
  const [targetMoves, setTargetMoves] = useState(8);
  const [userSide, setUserSide] = useState<Orientation>('white');
  const [phase, setPhase] = useState<PracticePhase>('setup');
  const [recoverPhase, setRecoverPhase] = useState<'opponent-loading' | 'user-loading'>('user-loading');
  const [fen, setFen] = useState(INITIAL_FEN);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [history, setHistory] = useState<PlayedMove[]>([]);
  const [opening, setOpening] = useState<OpeningExplorerPayload['opening']>();
  const [positionData, setPositionData] = useState<OpeningExplorerPayload | null>(null);
  const [evaluation, setEvaluation] = useState<OpeningMoveEvaluation | null>(null);
  const [lastOpponent, setLastOpponent] = useState<OpponentChoiceInfo | null>(null);
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completionReason, setCompletionReason] = useState<'target' | 'database' | 'game-over'>('target');
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [soundCount, setSoundCount] = useState(0);
  const [ungradedCount, setUngradedCount] = useState(0);
  const [mistakeCount, setMistakeCount] = useState(0);
  const [explorerCircuitOpen, setExplorerCircuitOpen] = useState(false);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [lastGradeSource, setLastGradeSource] = useState<'cloud' | 'local' | null>(null);
  const evaluationRequestRef = useRef(0);
  const submissionLockedRef = useRef(false);
  const evaluationAbortRef = useRef<AbortController | null>(null);
  const explorerCircuitRef = useRef(false);

  const userColor: Color = userSide === 'white' ? 'w' : 'b';
  const filters = useMemo<OpeningExplorerFilters>(() => ({
    speeds: SPEEDS,
    ratings: ratingBand === '1600'
      ? [1600, 1800, 2000, 2200, 2500]
      : [2000, 2200, 2500],
    moves: 12,
  }), [ratingBand]);

  const startSession = useCallback(() => {
    evaluationAbortRef.current?.abort();
    evaluationRequestRef.current += 1;
    submissionLockedRef.current = false;
    const resolvedSide = sideChoice === 'random'
      ? (Math.random() < 0.5 ? 'white' : 'black')
      : sideChoice;
    setUserSide(resolvedSide);
    setFen(INITIAL_FEN);
    setPendingMove(null);
    setHistory([]);
    setOpening(undefined);
    setPositionData(null);
    setEvaluation(null);
    setLastOpponent(null);
    setLastMoveUci(null);
    setSelected(null);
    setError(null);
    setAcceptedCount(0);
    setSoundCount(0);
    setUngradedCount(0);
    setMistakeCount(0);
    const startsLocally = sourceMode === 'engine' || !lichessConnected;
    explorerCircuitRef.current = startsLocally;
    setExplorerCircuitOpen(startsLocally);
    setSourceNotice(startsLocally
      ? (sourceMode === 'engine'
          ? '엔진 전용 모드: 모든 수를 이 기기의 Stockfish가 만듭니다.'
          : 'Lichess가 연결되지 않아 로컬 엔진으로 시작합니다.')
      : null);
    setLastGradeSource(null);
    setCompletionReason('target');
    setPhase(resolvedSide === 'white' ? 'user-loading' : 'opponent-loading');
  }, [lichessConnected, sideChoice, sourceMode]);

  useEffect(() => () => {
    evaluationAbortRef.current?.abort();
    disposeLocalEngine();
  }, []);

  useEffect(() => {
    if (phase === 'awaiting' || phase === 'retry') {
      submissionLockedRef.current = false;
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== 'opponent-loading') return;
    let cancelled = false;
    const abortController = new AbortController();
    setEvaluation(null);
    setSelected(null);
    setPositionData(null);

    void (async () => {
      try {
        const currentGame = new Chess(fen);
        if (currentGame.isGameOver()) {
          setCompletionReason('game-over');
          setPhase('complete');
          return;
        }

        let explorerOutcome: 'move' | 'empty' | 'failure' | 'skipped' = 'skipped';
        let databaseChoice: ReturnType<typeof selectOpponentMove> | undefined;
        if (sourceMode === 'auto' && !explorerCircuitRef.current && lichessConnected) {
          try {
            const explorer = await getOpeningExplorer(fen, filters);
            if (cancelled) return;
            setOpening((current) => explorer.opening ?? current);
            databaseChoice = selectOpponentMove(explorer, { frequencyExponent: 0.85 });
            explorerOutcome = databaseChoice ? 'move' : 'empty';
          } catch {
            explorerOutcome = 'failure';
          }
        }

        const sourceDecision = decideOpponentMoveSource({
          mode: sourceMode,
          explorerOutcome,
          explorerCircuitOpen: explorerCircuitRef.current || !lichessConnected,
        });
        if (sourceDecision.openExplorerCircuit) {
          explorerCircuitRef.current = true;
          setExplorerCircuitOpen(true);
          setSourceNotice('Lichess 데이터를 불러오지 못해 이 세션은 로컬 엔진으로 계속합니다.');
        } else if (explorerOutcome === 'empty') {
          setSourceNotice('이 포지션의 실전 표본이 없어 로컬 엔진이 상대 수를 골랐습니다.');
        }

        if (sourceDecision.source === 'database' && databaseChoice) {
          const game = new Chess(fen);
          const played = applyUci(game, databaseChoice.move.uci);
          setFen(game.fen());
          setHistory((current) => [...current, { uci: databaseChoice!.move.uci, san: played.san, color: played.color }]);
          setLastMoveUci(databaseChoice.move.uci);
          setLastOpponent({ source: 'database', san: played.san, games: databaseChoice.games, probability: databaseChoice.probability });
          if (game.isGameOver()) {
            setCompletionReason('game-over');
            setPhase('complete');
          } else {
            setPhase('user-loading');
          }
          return;
        }

        const suggestion = await suggestLocalMove(fen, {
          multiPv: 5,
          maxCpl: 45,
          random: Math.random,
          signal: abortController.signal,
        });
        if (cancelled) return;
        const game = new Chess(fen);
        const played = applyUci(game, suggestion.uci);
        setFen(game.fen());
        setHistory((current) => [...current, { uci: suggestion.uci, san: played.san, color: played.color }]);
        setLastMoveUci(suggestion.uci);
        setLastOpponent({ source: 'local-engine', san: played.san, depth: suggestion.depth });
        if (game.isGameOver()) {
          setCompletionReason('game-over');
          setPhase('complete');
        } else {
          setPhase('user-loading');
        }
      } catch (caught) {
        if (cancelled || isAbortError(caught)) return;
        setError(caught instanceof Error ? caught.message : '로컬 엔진이 상대 수를 만들지 못했습니다.');
        setRecoverPhase('opponent-loading');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [fen, filters, lichessConnected, phase, sourceMode]);

  useEffect(() => {
    if (phase !== 'user-loading') return;
    let cancelled = false;
    setSelected(null);

    void (async () => {
      if (sourceMode === 'engine' || explorerCircuitRef.current || !lichessConnected) {
        setPositionData(null);
        setPhase('awaiting');
        return;
      }
      try {
        const explorer = await getOpeningExplorer(fen, filters);
        if (cancelled) return;
        setPositionData(explorer);
        setOpening((current) => explorer.opening ?? current);
        setPhase('awaiting');
      } catch {
        if (cancelled) return;
        explorerCircuitRef.current = true;
        setExplorerCircuitOpen(true);
        setPositionData(null);
        setSourceNotice('Lichess 데이터를 불러오지 못해 이 세션은 로컬 엔진으로 계속합니다.');
        setPhase('awaiting');
      }
    })();

    return () => { cancelled = true; };
  }, [fen, filters, lichessConnected, phase, sourceMode]);

  useEffect(() => {
    if (phase !== 'accepted') return;
    const timer = window.setTimeout(() => {
      const game = new Chess(fen);
      if (acceptedCount >= targetMoves) {
        setCompletionReason('target');
        setPhase('complete');
      } else if (game.isGameOver()) {
        setCompletionReason('game-over');
        setPhase('complete');
      } else {
        setPhase('opponent-loading');
      }
    }, 680);
    return () => window.clearTimeout(timer);
  }, [acceptedCount, fen, phase, targetMoves]);

  const gradeCandidate = useCallback(async (candidate: PendingMove) => {
    if (submissionLockedRef.current) return;
    submissionLockedRef.current = true;
    const requestId = ++evaluationRequestRef.current;
    const wasRetry = phase === 'retry';
    const previousEvaluation = evaluation;
    const abortController = new AbortController();
    evaluationAbortRef.current?.abort();
    evaluationAbortRef.current = abortController;
    // Keep a legal candidate on its destination square while the asynchronous
    // engine verdict is pending. `fen` remains the authoritative position, so
    // a failed verdict can animate back without ever committing the move.
    setPendingMove(candidate);
    setPhase('grading');
    setSelected(null);
    if (!wasRetry) setEvaluation(null);
    setError(null);
    try {
      let result: OpeningMoveEvaluation;
      const forceLocal = sourceMode === 'engine' || explorerCircuitRef.current || !lichessConnected;
      if (forceLocal) {
        result = await evaluateLocalMove(
          { fen, uci: candidate.uci, san: candidate.san },
          { maxCpl: 80, signal: abortController.signal },
        );
        setLastGradeSource('local');
      } else {
        let cloudResult: OpeningMoveEvaluation | null = null;
        try {
          cloudResult = await evaluateOpeningMove(fen, candidate.uci, 80);
        } catch (cloudError) {
          if (isAbortError(cloudError)) throw cloudError;
        }
        if (cloudResult?.status === 'graded') {
          result = cloudResult;
          setLastGradeSource('cloud');
        } else {
          result = await evaluateLocalMove(
            { fen, uci: candidate.uci, san: candidate.san },
            { maxCpl: 80, signal: abortController.signal },
          );
          setLastGradeSource('local');
          setSourceNotice(cloudResult
            ? 'Lichess 엔진 평가가 없어 이 기기의 Stockfish로 판정했습니다.'
            : '원격 평가를 불러오지 못해 이 기기의 Stockfish로 판정했습니다.');
        }
      }
      if (requestId !== evaluationRequestRef.current) return;
      setEvaluation(result);
      if (result.status === 'graded' && result.verdict === 'fail') {
        setPendingMove(null);
        setMistakeCount((current) => current + 1);
        setPhase('retry');
        return;
      }

      setFen(candidate.fenAfter);
      setPendingMove(null);
      setHistory((current) => [...current, { uci: candidate.uci, san: candidate.san, color: userColor }]);
      setLastMoveUci(candidate.uci);
      setAcceptedCount((current) => current + 1);
      if (result.status === 'unavailable') setUngradedCount((current) => current + 1);
      else setSoundCount((current) => current + 1);
      setPhase('accepted');
    } catch (caught) {
      if (requestId !== evaluationRequestRef.current) return;
      setPendingMove(null);
      setEvaluation(previousEvaluation);
      setError(caught instanceof Error ? caught.message : '수를 평가하지 못했습니다.');
      setPhase(wasRetry ? 'retry' : 'awaiting');
    } finally {
      if (evaluationAbortRef.current === abortController) evaluationAbortRef.current = null;
    }
  }, [evaluation, fen, lichessConnected, phase, sourceMode, userColor]);

  const tryMove = useCallback((from: string, to: string | null): boolean => {
    if (!to || submissionLockedRef.current || (phase !== 'awaiting' && phase !== 'retry')) return false;
    const game = new Chess(fen);
    try {
      const move = game.move({ from: from as Square, to: to as Square, promotion: 'q' });
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      void gradeCandidate({ uci, san: move.san, fenAfter: game.fen() });
      return true;
    } catch {
      setSelected(null);
      setError('합법적인 수를 두세요.');
      return false;
    }
  }, [fen, gradeCandidate, phase]);

  const handleSquareClick = useCallback(({ square }: { square: string }) => {
    if (phase !== 'awaiting' && phase !== 'retry') return;
    const game = new Chess(fen);
    const piece = game.get(square as Square);
    if (!selected) {
      if (piece?.color === userColor) setSelected(square);
      return;
    }
    if (piece?.color === userColor) {
      setSelected(square);
      return;
    }
    tryMove(selected, square);
  }, [fen, phase, selected, tryMove, userColor]);

  const retryArrows: Arrow[] = evaluation?.status === 'graded' && evaluation.verdict === 'fail'
    ? evaluation.bestMoves.slice(0, 3).map((move, index) => ({
        startSquare: move.uci.slice(0, 2),
        endSquare: move.uci.slice(2, 4),
        color: index === 0 ? '#ed695d' : 'rgba(233, 183, 94, .82)',
      }))
    : [];
  const canMove = phase === 'awaiting' || phase === 'retry';
  const displayFen = pendingMove?.fenAfter ?? fen;
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (selected) styles[selected] = { boxShadow: 'inset 0 0 0 5px rgba(233, 183, 94, .92)' };
    if (phase === 'accepted' && lastMoveUci) {
      styles[lastMoveUci.slice(0, 2)] = { background: 'rgba(79, 203, 178, .5)' };
      styles[lastMoveUci.slice(2, 4)] = { background: 'rgba(79, 203, 178, .63)' };
    }
    return styles;
  }, [lastMoveUci, phase, selected]);

  const boardOptions = {
    id: 'opening-practice-board',
    position: displayFen,
    boardOrientation: userSide,
    allowDragging: canMove,
    allowDrawingArrows: false,
    showNotation: true,
    animationDurationInMs: 220,
    darkSquareStyle: { backgroundColor: '#567577' },
    lightSquareStyle: { backgroundColor: '#e8e1cf' },
    boardStyle: { borderRadius: '6px', boxShadow: '0 22px 60px rgba(6, 15, 27, .33)' },
    squareStyles,
    arrows: retryArrows,
    canDragPiece: ({ square }: { square: string | null }) => {
      if (!square || !canMove) return false;
      return new Chess(fen).get(square as Square)?.color === userColor;
    },
    onPieceDrop: ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      // Legal drops stay on the target square while soundness is graded. The
      // authoritative FEN is committed on pass, or restored (with animation)
      // only when the move fails or the request errors.
      return tryMove(sourceSquare, targetSquare);
    },
    onSquareClick: handleSquareClick,
  } as const;

  const feedback = reasonText(evaluation);
  const rows = moveRows(history);
  const games = positionData ? gameCount(positionData.results) : 0;
  const progress = Math.min(100, Math.round((acceptedCount / targetMoves) * 100));

  if (phase === 'setup') {
    return (
      <main className="practice-setup-shell">
        <div className="practice-setup-topline">
          <button className="back-button" type="button" onClick={onBack}><span aria-hidden="true">←</span> 라이브러리</button>
          <span className="practice-mode-label">OPENING PRACTICE</span>
        </div>
        <section className="practice-setup-card">
          <div className="practice-setup-intro">
            <span className="practice-kicker">♞ DATABASE + LOCAL ENGINE</span>
            <h1>라인을 외우지 말고,<br /><em>포지션에 답하세요.</em></h1>
            <p>상대는 Lichess 실전 빈도에 따라 두며, 데이터가 없으면 이 기기의 Stockfish가 이어받습니다. 나는 평가를 크게 해치지 않는 여러 대응 중 하나를 찾습니다.</p>
          </div>

          <div className="practice-options">
            <fieldset>
              <legend><span>01</span> 내 색</legend>
              <div className="choice-grid choice-grid-three">
                {(['random', 'white', 'black'] as const).map((choice) => (
                  <button type="button" className={sideChoice === choice ? 'is-selected' : ''} aria-pressed={sideChoice === choice} onClick={() => setSideChoice(choice)} key={choice}>
                    <b>{choice === 'random' ? '◈' : choice === 'white' ? '♙' : '♟'}</b>
                    <span>{choice === 'random' ? '랜덤' : choice === 'white' ? '백' : '흑'}</span>
                    <small>{choice === 'random' ? '매 세션 결정' : choice === 'white' ? '선공 연습' : '후공 연습'}</small>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend><span>02</span> 훈련 방식</legend>
              <div className="choice-grid choice-grid-two">
                <button type="button" className={sourceMode === 'auto' ? 'is-selected' : ''} aria-pressed={sourceMode === 'auto'} onClick={() => setSourceMode('auto')}>
                  <b>↻</b><span>자동 전환</span><small>{lichessConnected ? '실전 DB → 로컬 엔진' : 'Lichess 미연결 · 엔진 시작'}</small>
                </button>
                <button type="button" className={sourceMode === 'engine' ? 'is-selected' : ''} aria-pressed={sourceMode === 'engine'} onClick={() => setSourceMode('engine')}>
                  <b>♞</b><span>엔진 전용</span><small>이 기기의 Stockfish만 사용</small>
                </button>
              </div>
            </fieldset>

            {sourceMode === 'auto' && lichessConnected && (
              <fieldset>
                <legend><span>03</span> 상대 데이터</legend>
                <div className="choice-grid choice-grid-two">
                  <button type="button" className={ratingBand === '1600' ? 'is-selected' : ''} aria-pressed={ratingBand === '1600'} onClick={() => setRatingBand('1600')}><span>1600+</span><small>폭넓고 다양한 실전 수</small></button>
                  <button type="button" className={ratingBand === '2000' ? 'is-selected' : ''} aria-pressed={ratingBand === '2000'} onClick={() => setRatingBand('2000')}><span>2000+</span><small>상위권의 정제된 실전 수</small></button>
                </div>
              </fieldset>
            )}

            <fieldset>
              <legend><span>{sourceMode === 'auto' && lichessConnected ? '04' : '03'}</span> 세션 길이</legend>
              <div className="practice-length-control">
                {[6, 8, 12].map((length) => <button type="button" className={targetMoves === length ? 'is-selected' : ''} aria-pressed={targetMoves === length} onClick={() => setTargetMoves(length)} key={length}>{length}<small>내 수</small></button>)}
              </div>
            </fieldset>

            <div className="practice-rule-note"><span>±</span><p><strong>정답 한 수를 요구하지 않습니다.</strong><br />최선수보다 평가 손실 0.8폰 이내면 통과합니다. 평가 자료가 없을 때는 오답으로 처리하지 않습니다.</p></div>
            <button className="button button-primary practice-start-button" type="button" onClick={startSession}>실전 연습 시작 <span aria-hidden="true">→</span></button>
          </div>
        </section>
      </main>
    );
  }

  if (phase === 'complete') {
    const title = completionReason === 'target'
      ? '오늘의 실전 대응을 마쳤어요.'
      : completionReason === 'database'
        ? '데이터베이스 범위까지 탐험했어요.'
        : '게임이 끝나는 포지션까지 왔어요.';
    return (
      <main className="completion page-shell practice-completion">
        <div className="completion-card">
          <span className="completion-mark">✓</span>
          <span className="eyebrow">PRACTICE COMPLETE</span>
          <h1>{title}</h1>
          <p>{opening ? `${opening.eco} · ${opening.name}` : `${userSide === 'white' ? '백' : '흑'} 실전 연습`}</p>
          <div className="result-grid"><div><strong>{acceptedCount}</strong><small>통과한 대응</small></div><div><strong>{ungradedCount}</strong><small>판정 보류</small></div><div><strong>{mistakeCount}</strong><small>다시 둔 횟수</small></div></div>
          <div className="practice-completion-actions">
            <button className="button button-primary" type="button" onClick={startSession}>같은 설정으로 다시</button>
            <button className="button button-secondary" type="button" onClick={onBack}>라이브러리</button>
          </div>
        </div>
      </main>
    );
  }

  const localOpponentActive = sourceMode === 'engine' || explorerCircuitOpen || !lichessConnected;
  const opponentSourceLabel = lastOpponent?.source === 'local-engine' || (!lastOpponent && localOpponentActive)
    ? '로컬 엔진'
    : '실전 DB';
  const gradeSourceLabel = lastGradeSource === 'local'
    ? '로컬 엔진'
    : lastGradeSource === 'cloud'
      ? 'Lichess Cloud'
      : '대기 중';
  const feedbackTone = phase === 'retry' ? 'retry' : phase === 'accepted' ? 'correct' : phase === 'error' ? 'retry' : 'moving';
  const feedbackCopy = phase === 'opponent-loading'
    ? {
        title: '상대가 수를 고르는 중…',
        detail: localOpponentActive
          ? '이 기기의 Stockfish가 건전한 후보 중 다음 수를 선택합니다.'
          : 'Lichess 실전 빈도에 가중치를 두고, 실패하면 로컬 엔진으로 전환합니다.',
      }
    : phase === 'user-loading'
      ? {
          title: localOpponentActive ? '다음 대응을 준비하는 중…' : '포지션 통계를 불러오는 중…',
          detail: localOpponentActive ? '로컬 엔진 훈련을 계속 준비하고 있습니다.' : '이 포지션에서 실제로 나온 대응을 확인하고 있습니다.',
        }
      : phase === 'grading'
        ? { title: '대응을 평가하는 중…', detail: '정해진 라인이 아니라 포지션 평가 손실을 확인합니다.' }
        : phase === 'retry' || phase === 'accepted'
          ? feedback
          : phase === 'error'
            ? { title: '데이터를 불러오지 못했습니다', detail: error ?? '잠시 후 다시 시도해 주세요.' }
            : error
              ? {
                  title: error === '합법적인 수를 두세요.'
                    ? '합법적인 수를 두세요'
                    : '수를 평가하지 못했습니다',
                  detail: error,
                }
              : { title: `${userSide === 'white' ? '백' : '흑'}의 건전한 대응을 두세요`, detail: '정답은 하나가 아닙니다. 실제 게임처럼 가장 자연스러운 수를 찾아보세요.' };

  return (
    <main className="trainer-shell practice-session-shell">
      <div className="trainer-topline">
        <button className="back-button" type="button" onClick={onBack}><span aria-hidden="true">←</span> 라이브러리</button>
        <div className="trainer-title"><small>오프닝 연습 · {opponentSourceLabel}{opponentSourceLabel === '실전 DB' ? ` ${ratingBand}+` : ''}</small><strong>{opening ? `${opening.eco} · ${opening.name}` : localOpponentActive ? 'Stockfish Practice' : 'Opening Explorer'}</strong></div>
        <div className="trainer-counter"><span>{acceptedCount}</span> / {targetMoves}</div>
      </div>
      <div className="session-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="trainer-layout practice-layout">
        <section className="board-column" aria-label="체스판">
          <div className={`board-frame phase-${feedbackTone}`}><Chessboard options={boardOptions} /></div>
          <div className={`feedback feedback-${feedbackTone}`} role="status" aria-live="polite">
            <span className="feedback-symbol">{phase === 'retry' || phase === 'error' ? '!' : phase === 'accepted' ? '✓' : userSide === 'white' ? '♙' : '♟'}</span>
            <div><strong>{feedbackCopy.title}</strong><small>{feedbackCopy.detail}</small></div>
            {phase === 'error' && <button className="practice-inline-retry" type="button" onClick={() => { setError(null); setPhase(recoverPhase); }}>다시 시도</button>}
          </div>
        </section>

        <aside className="session-panel practice-panel">
          <div className="line-label"><span>LIVE POSITION</span><strong>{opening?.name ?? '오프닝을 탐색하는 중'}</strong></div>
          <div className="practice-db-strip">
            <div><small>내 색</small><strong>{userSide === 'white' ? '백 ♙' : '흑 ♟'}</strong></div>
            <div><small>상대 출처</small><strong>{opponentSourceLabel}</strong></div>
            <div><small>최근 판정</small><strong>{gradeSourceLabel}</strong></div>
          </div>
          {sourceNotice && <div className="practice-source-notice" role="status"><span>↻</span><p>{sourceNotice}</p></div>}
          <div className="move-sheet practice-moves">
            {rows.length === 0 && <div className="move-placeholder">{localOpponentActive ? '로컬 엔진이 첫 수를 준비하고 있어요.' : '실전 데이터에서 첫 수를 준비하고 있어요.'}</div>}
            {rows.map((row) => <div className="move-row" key={row.number}><span>{row.number}.</span><strong>{row.white?.san ?? ''}</strong><strong>{row.black?.san ?? ''}</strong></div>)}
            {phase === 'retry' && evaluation?.status === 'graded' && (
              <div className="practice-correction"><small>추천 대응</small><strong>{evaluation.bestMoves.slice(0, 3).map((move) => move.san ?? move.uci).join(' · ') || '화살표 확인'}</strong></div>
            )}
          </div>
          <div className="session-stats">
            <div><small>건전</small><strong>{soundCount}</strong></div>
            <div><small>판정 보류</small><strong>{ungradedCount}</strong></div>
            <div><small>재시도</small><strong className={mistakeCount ? 'danger' : ''}>{mistakeCount}</strong></div>
          </div>
          <div className={`practice-opponent-note ${lastOpponent?.source === 'local-engine' || (!lastOpponent && localOpponentActive) ? 'is-engine' : ''}`}>
            <span>{lastOpponent?.source === 'local-engine' || (!lastOpponent && localOpponentActive) ? 'SF' : 'DB'}</span>
            <p>
              {lastOpponent?.source === 'database'
                ? <><strong>{lastOpponent.san}</strong> · 후보군 선택 확률 {Math.round(lastOpponent.probability * 100)}% · {lastOpponent.games.toLocaleString('ko-KR')}국</>
                : lastOpponent?.source === 'local-engine'
                  ? <><strong>{lastOpponent.san}</strong> · 이 기기의 Stockfish · 깊이 {lastOpponent.depth}</>
                  : localOpponentActive
                    ? <>로컬 Stockfish가 인터넷 데이터 없이 상대 수를 만듭니다.</>
                    : <>블리츠·래피드·클래식 실전 수를 사용합니다.{games ? ` · 현재 ${games.toLocaleString('ko-KR')}국` : ''}</>}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
