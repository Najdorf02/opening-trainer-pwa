import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Chess, type Color, type Square } from 'chess.js';
import { Chessboard, type Arrow } from 'react-chessboard';

import type { GameRepertoireReview } from '../shared/game-review.js';
import {
  assessResponseAfterOpponentUncovered,
  classifyReviewedMoves,
  createLearnFromMistakesDrillItems,
  selectUserMovesForEngineReview,
  type ClassifiedReviewedMove,
  type EvaluatedReviewedMove,
  type LearnFromMistakeDrillItem,
  type UncoveredResponseAssessment,
} from '../shared/mistake-review.js';
import { evaluateLocalMove } from './local-engine.js';

const REVIEW_DEPTH = 12;
const ACCEPTABLE_LOSS_CP = 80;
const MAX_CACHED_GAMES = 8;

type ScanStatus = 'idle' | 'scanning' | 'complete' | 'cancelled' | 'error';
type DrillPhase = 'awaiting' | 'checking' | 'retry' | 'correct';

export interface MistakeReviewAnalysis {
  evaluatedMoves: EvaluatedReviewedMove[];
  response?: UncoveredResponseAssessment;
  /** Meaningful errors other than the separately displayed novelty response. */
  mistakes: ClassifiedReviewedMove[];
  drillItems: LearnFromMistakeDrillItem[];
}

interface MistakeDrillState {
  item: LearnFromMistakeDrillItem;
  phase: DrillPhase;
  fen: string;
  wrongAttempts: number;
  correctMoveUci?: string;
  lastLossCp?: number;
  message?: string;
}

export interface MistakeReviewProps {
  review: GameRepertoireReview;
  /** Receives the zero-based game cursor immediately before the reviewed move. */
  onShowPosition?: (cursor: number) => void;
}

const analysisCache = new Map<string, MistakeReviewAnalysis>();

function reviewCacheKey(review: GameRepertoireReview): string {
  const last = review.moves.at(-1);
  return [
    review.meta.id,
    review.status,
    review.matchedPlies,
    review.moves.length,
    last?.uci ?? '-',
  ].join(':');
}

function cacheAnalysis(key: string, analysis: MistakeReviewAnalysis): void {
  // Reinsertion gives this tiny cache useful LRU behaviour when returning to a game.
  analysisCache.delete(key);
  analysisCache.set(key, analysis);
  while (analysisCache.size > MAX_CACHED_GAMES) {
    const oldest = analysisCache.keys().next().value as string | undefined;
    if (!oldest) break;
    analysisCache.delete(oldest);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function engineErrorMessage(error: unknown): string {
  if (isAbortError(error)) return '분석을 취소했습니다.';
  return error instanceof Error
    ? `로컬 엔진 분석을 마치지 못했습니다. ${error.message}`
    : '로컬 엔진 분석을 마치지 못했습니다.';
}

function moveLabel(move: ClassifiedReviewedMove['move']): string {
  return `${move.moveNumber}${move.mover === 'black' ? '…' : '.'} ${move.san}`;
}

function uciArrow(uci: string, color: string): Arrow | undefined {
  if (!/^[a-h][1-8][a-h][1-8]/i.test(uci)) return undefined;
  return {
    startSquare: uci.slice(0, 2),
    endSquare: uci.slice(2, 4),
    color,
  };
}

function recommendedCopy(item: LearnFromMistakeDrillItem | undefined): string {
  if (!item) return '추천 수를 만들 수 없는 포지션입니다.';
  return item.recommendedMoves
    .slice(0, 3)
    .map((candidate) => candidate.san ?? candidate.uci)
    .join(' · ');
}

function candidateCopy(finding: ClassifiedReviewedMove): string {
  return finding.evaluation.bestMoves
    .slice(0, 3)
    .map((candidate) => candidate.san ?? candidate.uci)
    .join(' · ');
}

function makeMove(
  item: LearnFromMistakeDrillItem,
  from: string,
  to: string,
): { uci: string; fenAfter: string; san: string } | undefined {
  const base = `${from}${to}`.toLowerCase();
  const matchingRecommendation = item.recommendedMoves.find((candidate) => candidate.uci.startsWith(base));
  const promotion = matchingRecommendation?.uci.slice(4, 5)
    || (/[18]$/.test(to) ? 'q' : undefined);

  try {
    const chess = new Chess(item.fen);
    const played = chess.move({
      from: from as Square,
      to: to as Square,
      ...(promotion ? { promotion } : {}),
    });
    if (!played) return undefined;
    return {
      uci: `${played.from}${played.to}${played.promotion ?? ''}`.toLowerCase(),
      fenAfter: chess.fen(),
      san: played.san,
    };
  } catch {
    return undefined;
  }
}

function buildAnalysis(
  review: GameRepertoireReview,
  evaluatedMoves: EvaluatedReviewedMove[],
): MistakeReviewAnalysis {
  const response = assessResponseAfterOpponentUncovered(review, evaluatedMoves);
  const mistakes = classifyReviewedMoves(evaluatedMoves).filter((finding) => (
    finding.meaningfulError && finding.move.ply !== response?.responseMove.ply
  ));
  return {
    evaluatedMoves,
    response,
    mistakes,
    drillItems: createLearnFromMistakesDrillItems(review, evaluatedMoves),
  };
}

export function MistakeReview({ review, onShowPosition }: MistakeReviewProps) {
  const cacheKey = useMemo(() => reviewCacheKey(review), [review]);
  const reviewTargets = useMemo(() => selectUserMovesForEngineReview(review), [review]);
  const cached = analysisCache.get(cacheKey);
  const [status, setStatus] = useState<ScanStatus>(cached ? 'complete' : 'idle');
  const [analysis, setAnalysis] = useState<MistakeReviewAnalysis | null>(cached ?? null);
  const [progress, setProgress] = useState(cached ? reviewTargets.length : 0);
  const [errorMessage, setErrorMessage] = useState('');
  const [drill, setDrill] = useState<MistakeDrillState | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const drillAbortRef = useRef<AbortController | null>(null);
  const drillJobRef = useRef(0);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    drillAbortRef.current?.abort();
    drillAbortRef.current = null;
    drillJobRef.current += 1;
    const saved = analysisCache.get(cacheKey) ?? null;
    setAnalysis(saved);
    setStatus(saved ? 'complete' : 'idle');
    setProgress(saved ? reviewTargets.length : 0);
    setErrorMessage('');
    setDrill(null);
    setSelectedSquare(null);
  }, [cacheKey, reviewTargets.length]);

  useEffect(() => () => {
    abortRef.current?.abort();
    drillAbortRef.current?.abort();
  }, []);

  const runAnalysis = useCallback(async () => {
    if (status === 'scanning') return;
    const alreadyCached = analysisCache.get(cacheKey);
    if (alreadyCached) {
      // Returning to a previously analysed game should not wake Stockfish again.
      setAnalysis(alreadyCached);
      setProgress(reviewTargets.length);
      setStatus('complete');
      return;
    }

    if (reviewTargets.length === 0) {
      const empty = buildAnalysis(review, []);
      cacheAnalysis(cacheKey, empty);
      setAnalysis(empty);
      setProgress(0);
      setStatus('complete');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAnalysis(null);
    setProgress(0);
    setErrorMessage('');
    setDrill(null);
    setStatus('scanning');

    const evaluatedMoves: EvaluatedReviewedMove[] = [];
    try {
      for (let index = 0; index < reviewTargets.length; index += 1) {
        const move = reviewTargets[index];
        const evaluation = await evaluateLocalMove({
          fen: move.beforeFen,
          uci: move.uci,
          san: move.san,
        }, {
          depth: REVIEW_DEPTH,
          maxCpl: ACCEPTABLE_LOSS_CP,
          signal: controller.signal,
        });

        if (evaluation.status !== 'graded') {
          throw new Error('이 포지션의 엔진 평가값을 받지 못했습니다.');
        }
        evaluatedMoves.push({ move, evaluation });
        if (!controller.signal.aborted && abortRef.current === controller) {
          setProgress(index + 1);
        }
      }

      if (controller.signal.aborted || abortRef.current !== controller) return;
      const completed = buildAnalysis(review, evaluatedMoves);
      cacheAnalysis(cacheKey, completed);
      setAnalysis(completed);
      setStatus('complete');
    } catch (error) {
      if (abortRef.current !== controller) return;
      if (isAbortError(error) || controller.signal.aborted) {
        setStatus('cancelled');
        setErrorMessage('분석을 취소했습니다. 원할 때 처음부터 다시 시작할 수 있습니다.');
      } else {
        setStatus('error');
        setErrorMessage(engineErrorMessage(error));
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [cacheKey, review, reviewTargets, status]);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startDrill = useCallback((item: LearnFromMistakeDrillItem) => {
    drillAbortRef.current?.abort();
    drillAbortRef.current = null;
    drillJobRef.current += 1;
    setDrill({
      item,
      phase: 'awaiting',
      fen: item.fen,
      wrongAttempts: 0,
    });
    setSelectedSquare(null);
  }, []);

  const tryDrillMove = useCallback((from: string, to: string | null): boolean => {
    if (!to || !drill || (drill.phase !== 'awaiting' && drill.phase !== 'retry')) return false;
    const item = drill.item;
    const played = makeMove(item, from, to);
    setSelectedSquare(null);
    if (!played) {
      setDrill((current) => current ? { ...current, message: '합법적인 수를 두세요.' } : current);
      return false;
    }

    drillAbortRef.current?.abort();
    const controller = new AbortController();
    drillAbortRef.current = controller;
    const job = ++drillJobRef.current;
    setDrill((current) => current?.item.id === item.id ? {
      ...current,
      phase: 'checking',
      fen: played.fenAfter,
      correctMoveUci: undefined,
      lastLossCp: undefined,
      message: undefined,
    } : current);

    void evaluateLocalMove({
      fen: item.fen,
      uci: played.uci,
      san: played.san,
    }, {
      depth: REVIEW_DEPTH,
      maxCpl: ACCEPTABLE_LOSS_CP,
      signal: controller.signal,
    }).then((evaluation) => {
      if (controller.signal.aborted || drillAbortRef.current !== controller || drillJobRef.current !== job) return;
      if (evaluation.status !== 'graded') throw new Error('이 수의 엔진 평가값을 받지 못했습니다.');
      setDrill((current) => {
        if (!current || current.item.id !== item.id) return current;
        if (evaluation.passed) {
          return {
            ...current,
            phase: 'correct',
            fen: played.fenAfter,
            correctMoveUci: played.uci,
            lastLossCp: evaluation.centipawnLoss,
            message: undefined,
          };
        }
        return {
          ...current,
          phase: 'retry',
          fen: item.fen,
          wrongAttempts: current.wrongAttempts + 1,
          correctMoveUci: undefined,
          lastLossCp: evaluation.centipawnLoss,
          message: undefined,
        };
      });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || drillAbortRef.current !== controller || drillJobRef.current !== job) return;
      setDrill((current) => current?.item.id === item.id ? {
        ...current,
        phase: 'awaiting',
        fen: item.fen,
        correctMoveUci: undefined,
        lastLossCp: undefined,
        message: engineErrorMessage(error),
      } : current);
    }).finally(() => {
      if (drillAbortRef.current === controller) drillAbortRef.current = null;
    });
    return true;
  }, [drill]);

  const handleSquareClick = useCallback(({ square }: { square: string }) => {
    if (!drill || (drill.phase !== 'awaiting' && drill.phase !== 'retry')) return;
    const chess = new Chess(drill.item.fen);
    const piece = chess.get(square as Square);
    const mover: Color = drill.item.mover === 'white' ? 'w' : 'b';
    if (!selectedSquare) {
      if (piece?.color === mover) setSelectedSquare(square);
      return;
    }
    if (piece?.color === mover) {
      setSelectedSquare(square);
      return;
    }
    tryDrillMove(selectedSquare, square);
  }, [drill, selectedSquare, tryDrillMove]);

  const drillArrows = useMemo(() => {
    if (!drill) return [];
    if (drill.phase === 'correct' && drill.correctMoveUci) {
      const arrow = uciArrow(drill.correctMoveUci, '#4fcbb2');
      return arrow ? [arrow] : [];
    }
    if (drill.phase !== 'retry') return [];
    return drill.item.recommendedMoves
      .slice(0, 3)
      .map((candidate) => uciArrow(candidate.uci, '#4fcbb2'))
      .filter((arrow): arrow is Arrow => Boolean(arrow));
  }, [drill]);

  const drillSquareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    if (selectedSquare) {
      styles[selectedSquare] = { boxShadow: 'inset 0 0 0 5px rgba(233,183,94,.9)' };
    }
    if (drill?.phase === 'correct' && drill.correctMoveUci) {
      styles[drill.correctMoveUci.slice(0, 2)] = { background: 'rgba(79,203,178,.5)' };
      styles[drill.correctMoveUci.slice(2, 4)] = { background: 'rgba(79,203,178,.64)' };
    }
    return styles;
  }, [drill, selectedSquare]);

  const responseDrill = analysis?.response
    ? analysis.drillItems.find((item) => item.ply === analysis.response?.responseMove.ply)
    : undefined;
  const meaningfulCount = (analysis?.mistakes.length ?? 0)
    + (analysis?.response?.review.meaningfulError ? 1 : 0);
  const canMove = Boolean(drill && (drill.phase === 'awaiting' || drill.phase === 'retry'));

  return (
    <section className="review-engine-card mistake-review-card" aria-labelledby="mistake-review-title">
      <span id="mistake-review-title">실수로부터 배우기 · 전체 대국 분석</span>
      <p>대국 전체에서 내가 둔 모든 수를 이 기기의 Stockfish로 차례대로 확인합니다.</p>
      <small className="mistake-review-note">
        전술·전략 분류는 엔진 진행의 체크·잡기·메이트 단서를 이용한 보수적인 휴리스틱이며, 사람의 해설처럼 원인을 확정하지는 않습니다.
      </small>

      {status !== 'scanning' && status !== 'complete' && (
        <button className="button button-secondary" type="button" onClick={() => void runAnalysis()}>
          {status === 'idle' ? '전체 수 분석 시작' : '처음부터 다시 분석'}
        </button>
      )}

      {status === 'scanning' && (
        <div className="mistake-review-progress" role="status" aria-live="polite">
          <strong>로컬 엔진 분석 중 · {progress} / {reviewTargets.length}</strong>
          <progress value={progress} max={Math.max(1, reviewTargets.length)} />
          <small>아이폰에서는 화면을 켜 둔 채 기다려 주세요. 분석 중에는 배터리 사용량이 늘 수 있습니다.</small>
          <button className="button button-secondary" type="button" onClick={cancelAnalysis}>분석 취소</button>
        </div>
      )}

      {(status === 'cancelled' || status === 'error') && (
        <div className="review-engine-result is-error" role="alert">
          <strong>{status === 'cancelled' ? '분석 취소됨' : '분석 오류'}</strong>
          <span>{errorMessage}</span>
        </div>
      )}

      {status === 'complete' && analysis && (
        <div className="mistake-review-results">
          <div className="mistake-review-summary" role="status">
            <strong>{reviewTargets.length}수 분석 완료</strong>
            <span>{meaningfulCount ? `다시 볼 지점 ${meaningfulCount}개` : '엔진이 확인한 의미 있는 실수 없음'}</span>
          </div>

          {reviewTargets.length === 0 && (
            <p className="mistake-review-empty">이 대국에는 분석할 내 수가 없습니다.</p>
          )}

          {analysis.response && (
            <article className={`mistake-response is-${analysis.response.kind}`}>
              <small>상대가 첫 이론수를 벗어난 직후</small>
              <strong>{analysis.response.label}</strong>
              <p>
                상대 {analysis.response.opponentMove.san} 뒤 {analysis.response.responseMove.san}
                {' · '}손실 {analysis.response.review.evaluation.centipawnLoss}cp
              </p>
              <span>엔진 후보 {candidateCopy(analysis.response.review) || '표시할 수 없음'}</span>
              <div className="mistake-review-actions">
                <button type="button" onClick={() => onShowPosition?.(Math.max(0, analysis.response!.responseMove.ply - 1))}>보드에서 보기</button>
                {analysis.response.review.meaningfulError && responseDrill && (
                  <button className="button button-primary" type="button" onClick={() => startDrill(responseDrill)}>지금 다시 두기</button>
                )}
              </div>
            </article>
          )}

          {analysis.mistakes.length > 0 && (
            <div className="mistake-review-list">
              <h3>다시 볼 실수</h3>
              {analysis.mistakes.map((finding) => {
                const item = analysis.drillItems.find((candidate) => candidate.ply === finding.move.ply);
                return (
                  <article className={`mistake-review-item is-${finding.severity}`} key={finding.move.ply}>
                    <div className="mistake-review-item-heading">
                      <strong>{moveLabel(finding.move)}</strong>
                      <span>{finding.severityLabel} · {finding.themeLabel}</span>
                    </div>
                    <p>{finding.reason.title}</p>
                    <small>{finding.reason.detail}</small>
                    <div className="mistake-review-evaluation">
                      <span>평가 손실 {finding.evaluation.centipawnLoss}cp</span>
                      <span>추천 {candidateCopy(finding) || '표시할 수 없음'}</span>
                    </div>
                    <div className="mistake-review-actions">
                      <button type="button" onClick={() => onShowPosition?.(Math.max(0, finding.move.ply - 1))}>보드에서 보기</button>
                      {item && <button className="button button-primary" type="button" onClick={() => startDrill(item)}>지금 다시 두기</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {meaningfulCount === 0 && reviewTargets.length > 0 && (
            <p className="mistake-review-empty">좋습니다. 대국 전체에서 엔진이 다시 볼 만한 실수를 찾지 못했습니다.</p>
          )}
        </div>
      )}

      {drill && (
        <div className={`mistake-drill phase-${drill.phase}`}>
          <div className="mistake-drill-heading">
            <span>직접 다시 두기</span>
            <strong>{drill.item.moveNumber}{drill.item.mover === 'black' ? '…' : '.'} 직전 포지션</strong>
          </div>
          <div className="mistake-drill-board">
            <Chessboard options={{
              id: `mistake-drill-${drill.item.id}`,
              position: drill.fen,
              boardOrientation: drill.item.mover,
              allowDragging: canMove,
              allowDrawingArrows: false,
              showNotation: true,
              showAnimations: true,
              animationDurationInMs: 220,
              arrows: drillArrows,
              squareStyles: drillSquareStyles,
              darkSquareStyle: { backgroundColor: '#567577' },
              lightSquareStyle: { backgroundColor: '#d9ded3' },
              boardStyle: { borderRadius: '7px', boxShadow: '0 16px 38px rgba(0,0,0,.22)' },
              canDragPiece: ({ square }: { square: string | null }) => {
                if (!square || !canMove) return false;
                const mover: Color = drill.item.mover === 'white' ? 'w' : 'b';
                return new Chess(drill.item.fen).get(square as Square)?.color === mover;
              },
              onPieceDrop: ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => tryDrillMove(sourceSquare, targetSquare),
              onSquareClick: handleSquareClick,
            }} />
          </div>
          {drill.phase === 'awaiting' && (
            <div className="review-engine-result is-loading" role="status">
              <strong>내 차례</strong>
              <span>추천 수는 숨겼습니다. 엔진 기준으로 건전한 대응을 직접 찾아보세요.</span>
            </div>
          )}
          {drill.phase === 'checking' && (
            <div className="review-engine-result is-loading" role="status">
              <strong>이 대응을 확인하는 중</strong>
              <span>추천 수와 똑같지 않아도 손실이 {ACCEPTABLE_LOSS_CP}cp 이내면 통과합니다.</span>
            </div>
          )}
          {drill.phase === 'retry' && (
            <div className="review-engine-result is-fail" role="alert">
              <strong>손실 {drill.lastLossCp ?? '?'}cp · 원위치에서 다시 시도</strong>
              <span>추천 {recommendedCopy(drill.item)}</span>
            </div>
          )}
          {drill.phase === 'correct' && (
            <div className="review-engine-result is-pass" role="status">
              <strong>건전한 대응입니다 · 손실 {drill.lastLossCp ?? 0}cp</strong>
              <span>{drill.wrongAttempts ? `오답 ${drill.wrongAttempts}회 뒤 통과했습니다.` : '첫 시도에 통과했습니다.'}</span>
            </div>
          )}
          {drill.message && (
            <div className="review-engine-result is-error" role="alert"><strong>다시 확인</strong><span>{drill.message}</span></div>
          )}
          <button className="button button-secondary" type="button" onClick={() => {
            drillAbortRef.current?.abort();
            drillAbortRef.current = null;
            drillJobRef.current += 1;
            setDrill(null);
            setSelectedSquare(null);
          }}>훈련 닫기</button>
        </div>
      )}
    </section>
  );
}
