import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chess, type Color } from 'chess.js';
import { Chessboard, type Arrow } from 'react-chessboard';
import type { RepertoireChapter, RepertoireMove } from '../shared/repertoire.js';
import { ChapterTrainer, type PromptMove, type TrainerSnapshot, type TrainerTransition } from '../shared/trainer.js';
import { beginLogin, getAuthStatus, getChapter, getLibrary, logout, syncStudies } from './api';
import ChessComReview from './ChessComReview';
import OpeningPractice from './OpeningPractice';
import {
  createRootStudyAnnotationMoment,
  extractStudyAnnotationMoments,
  type StudyAnnotationMoment,
} from './study-annotations.js';
import type { AuthStatus, ChapterDetail, ChapterSummary, LibraryPayload, StudySummary, SyncResult } from './types';

type Toast = { message: string; tone: 'success' | 'error' } | null;

const Icon = ({ name, size = 20 }: { name: 'book' | 'sync' | 'lock' | 'arrow' | 'check' | 'spark' | 'target' | 'logout' | 'back' | 'external' | 'clock'; size?: number }) => {
  const paths: Record<typeof name, React.ReactNode> = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v15h4.5a2.5 2.5 0 0 1 2.5 2.5z"/></>,
    sync: <><path d="M20 7h-5V2"/><path d="M20 7a8 8 0 0 0-13.7-2.6L4 7"/><path d="M4 17h5v5"/><path d="M4 17a8 8 0 0 0 13.7 2.6L20 17"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    spark: <><path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/></>,
    target: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/></>,
    logout: <><path d="M10 5H5v14h5"/><path d="M14 8l4 4-4 4M18 12H9"/></>,
    back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
};

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40"><path d="M12 30.5h19v4H9.5c-.4-1.8.4-3.1 2.5-4Zm3.1-3.2c.2-3.3 1.4-5.8 3.6-7.5-1.7-1.2-2.6-3-2.7-5.2 2.2.1 4.1-.6 5.7-2.1l-2.2-3.2 3.4-3.1 8.7 6.2-2.7 4.1c2.2 3.2 2.6 6.8 1.2 10.8H15.1Z"/></svg>
    </span>
  );
}

function Header({ auth, onLogin, onLogout, busy }: { auth: AuthStatus; onLogin: () => void; onLogout: () => void; busy: boolean }) {
  return (
    <header className="topbar">
      <a className="brand" href={import.meta.env.BASE_URL} aria-label="Opening Room 홈">
        <Mark />
        <span><strong>Opening Room</strong><small>나만의 오프닝 훈련실</small></span>
      </a>
      <div className="account-area">
        {auth.connected ? (
          <>
            <div className="connected-pill"><span className="status-dot" /> <span className="account-copy"><small>LICHESS 연결됨</small><strong>{auth.username ?? 'SaturdayCthuns'}</strong></span></div>
            <button className="icon-button" type="button" onClick={onLogout} disabled={busy} aria-label="리체스 연결 해제"><Icon name="logout" /></button>
          </>
        ) : (
          <button className="button button-secondary button-small" type="button" onClick={onLogin} disabled={busy}><Icon name="lock" size={17} /> Lichess 연결</button>
        )}
      </div>
    </header>
  );
}

function EmptyLibrary({ onSync }: { onSync: () => void }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="book" size={28} /></span><h3>가져온 연구가 없습니다</h3><p>리체스에서 직접 만든 연구를 동기화하면 이곳에 챕터별로 정리됩니다.</p><button className="button button-primary" onClick={onSync}><Icon name="sync" /> 지금 동기화</button></div>;
}

function StudyCard({ study, onTrain }: { study: StudySummary; onTrain: (chapter: ChapterSummary) => void }) {
  const [open, setOpen] = useState(true);
  const color = study.orientation ?? study.chapters[0]?.orientation ?? 'white';
  const totalCards = study.chapters.reduce((sum, chapter) => sum + chapter.cardCount, 0);
  return (
    <article className={`study-card ${open ? 'is-open' : ''}`}>
      <button className="study-heading" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`color-piece ${color}`}>{color === 'white' ? '♙' : '♟'}</span>
        <span className="study-title"><small>{color === 'white' ? '백 레퍼토리' : '흑 레퍼토리'}</small><strong>{study.name}</strong></span>
        <span className="study-meta">{study.chapters.length} 챕터 · {totalCards || '—'} 포지션</span>
        <span className="chevron">⌄</span>
      </button>
      {open && (
        <div className="chapter-list">
          {study.chapters.map((chapter, index) => (
            <div className="chapter-row" key={chapter.id}>
              <span className="chapter-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="chapter-copy"><strong>{chapter.name}</strong><small>{chapter.lineCount || '—'} 라인 · {chapter.cardCount || '—'} 포지션</small></span>
              <span className="mastery" aria-label="새 챕터"><i style={{ width: '0%' }} /><small>새 챕터</small></span>
              {chapter.sourceUrl && <a className="source-link" href={chapter.sourceUrl} target="_blank" rel="noreferrer" aria-label="리체스에서 보기" onClick={(event) => event.stopPropagation()}><Icon name="external" size={17} /></a>}
              <button className="button chapter-button" type="button" onClick={() => onTrain(chapter)}>훈련 <Icon name="arrow" size={17} /></button>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function LibraryScreen({ library, auth, syncing, lastSync, libraryError, syncReport, onSync, onTrain, onPractice, onReview }: { library: LibraryPayload; auth: AuthStatus; syncing: boolean; lastSync: string | null; libraryError: string | null; syncReport: SyncResult | null; onSync: () => void; onTrain: (chapter: ChapterSummary) => void; onPractice: () => void; onReview: () => void }) {
  const chapterCount = library.studies.reduce((sum, study) => sum + study.chapters.length, 0);
  const positionCount = library.studies.reduce((total, study) => total + study.chapters.reduce((sum, chapter) => sum + chapter.cardCount, 0), 0);
  const syncErrors = Array.isArray(syncReport?.errors) ? syncReport.errors : [];
  return (
    <main className="library page-shell">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><Icon name="spark" size={17} /> ACTIVE RECALL TRAINING</span>
          <h1>외운 수가 아니라,<br /><em>떠올리는 힘</em>을 훈련하세요.</h1>
          <p>내 리체스 연구를 챕터별로 반복하고, 틀린 포지션은 곧바로 다시 풀어 확실히 기억합니다.</p>
        </div>
        <div className="hero-stats">
          <div><span className="stat-icon coral"><Icon name="book" /></span><strong>{library.studies.length}</strong><small>연구</small></div>
          <div><span className="stat-icon aqua"><Icon name="target" /></span><strong>{chapterCount}</strong><small>챕터</small></div>
          <div><span className="stat-icon gold"><Icon name="clock" /></span><strong>{positionCount || '—'}</strong><small>훈련 포지션</small></div>
        </div>
      </section>

      {library.sample && !auth.connected && (
        <section className="sample-banner">
          <span className="sample-badge">SAMPLE</span>
          <div><strong>먼저 체험해 보세요</strong><p>샘플 레퍼토리로 훈련 흐름을 확인할 수 있어요. 비공개 연구는 Lichess 연결 후 이 기기에만 가져옵니다.</p></div>
          <span className="private-note"><Icon name="lock" size={16} /> 공개 전환 불필요</span>
        </section>
      )}

      {libraryError && (
        <section className="status-banner status-error" role="alert">
          <span className="status-badge">ERROR</span>
          <div><strong>연결된 연구 목록을 불러오지 못했습니다</strong><p>{libraryError}</p></div>
        </section>
      )}

      {syncReport && (
        <section className={`status-banner ${syncReport.failed ? 'status-warning' : 'status-success'}`} aria-live="polite">
          <span className="status-badge">SYNC</span>
          <div>
            <strong>동기화 결과</strong>
            <p>가져옴 {syncReport.imported} · 변경 없음 {syncReport.skipped} · 실패 {syncReport.failed}</p>
            {syncErrors.length > 0 && <ul>{syncErrors.map((error) => <li key={`${error.studyId}:${error.message}`}><b>{error.studyName || error.studyId}</b> — {error.message}</li>)}</ul>}
          </div>
        </section>
      )}

      <section className="practice-launch-card">
        <div className="practice-launch-visual" aria-hidden="true">
          <span className="practice-pulse" />
          <span className="practice-knight">♞</span>
          <small>DB + ENGINE</small>
        </div>
        <div className="practice-launch-copy">
          <span className="eyebrow">OPENING PRACTICE</span>
          <h2>정해진 라인 밖에서도 대응해 보세요.</h2>
          <p>Lichess 실전 빈도를 우선 사용하고, 데이터가 없거나 연결이 끊기면 로컬 엔진이 이어서 두는 자유 연습입니다.</p>
          <div className="practice-tags"><span>실전 빈도</span><span>엔진 자동 전환</span><span>0.8폰 허용</span></div>
        </div>
        <div className="practice-launch-action">
          {!auth.connected && <small>엔진 모드는 로그인 없이 사용 가능</small>}
          <button className="button button-primary" type="button" onClick={onPractice}>실전 연습 시작 <Icon name="arrow" size={17} /></button>
        </div>
      </section>

      <section className="review-launch-card">
        <div className="review-launch-icon" aria-hidden="true">
          <span>♜</span>
          <small>PGN</small>
        </div>
        <div className="review-launch-copy">
          <span className="eyebrow">CHESS.COM GAME REVIEW</span>
          <h2>내 실전에서 레퍼토리를 놓친 순간을 찾으세요.</h2>
          <p>최근 공개 대국을 불러와 리체스 연구와 비교하고, 처음 달라진 포지션부터 다시 확인합니다.</p>
        </div>
        <div className="review-launch-action">
          <small>기본 계정 <strong>Yshaarrj</strong></small>
          <button className="button button-secondary" type="button" onClick={onReview}>최근 대국 복기 <Icon name="arrow" size={17} /></button>
        </div>
      </section>

      <section className="section-head">
        <div><span className="eyebrow">MY REPERTOIRES</span><h2>{library.sample ? '샘플 훈련 라이브러리' : '내 레퍼토리'}</h2></div>
        <div className="sync-area">
          {lastSync && <small>최근 동기화 {lastSync}</small>}
          {auth.connected && <button className="button button-secondary" onClick={onSync} disabled={syncing}><Icon name="sync" /> {syncing ? '가져오는 중…' : '연구 동기화'}</button>}
        </div>
      </section>

      {library.studies.length ? <div className="study-grid">{library.studies.map((study) => <StudyCard study={study} onTrain={onTrain} key={study.id} />)}</div> : <EmptyLibrary onSync={onSync} />}
    </main>
  );
}

type TrainerPhase = 'moving' | 'awaiting' | 'retry' | 'correct' | 'note' | 'complete';
type CorrectFeedback = 'target' | 'alternative' | null;

function studyAnnotationMomentsForTransition(
  transition: TrainerTransition,
  repertoire: RepertoireChapter,
): StudyAnnotationMoment[] {
  const moveMoments = extractStudyAnnotationMoments(transition);
  if (!transition.events.some((event) => event.type === 'line-started')) {
    return moveMoments;
  }

  const rootMoment = createRootStudyAnnotationMoment(
    repertoire.rootFen,
    repertoire.rootAnnotations,
  );
  return rootMoment ? [rootMoment, ...moveMoments] : moveMoments;
}

function TrainerScreen({ chapter, onBack }: { chapter: ChapterDetail; onBack: () => void }) {
  const [{ trainer, initialTransition }] = useState(() => {
    const nextTrainer = new ChapterTrainer(chapter.repertoire);
    return { trainer: nextTrainer, initialTransition: nextTrainer.start() };
  });
  const [snapshot, setSnapshot] = useState<TrainerSnapshot>(initialTransition.snapshot);
  const [annotationMoments, setAnnotationMoments] = useState<StudyAnnotationMoment[]>(
    () => studyAnnotationMomentsForTransition(initialTransition, chapter.repertoire),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<PromptMove | null>(null);
  const [knownAvoidMove, setKnownAvoidMove] = useState<RepertoireMove | null>(null);
  const [correctFeedback, setCorrectFeedback] = useState<CorrectFeedback>(null);
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const repertoire = chapter.repertoire;
  const activeAnnotation = annotationMoments[0] ?? null;
  const userColor: Color = chapter.orientation === 'white' ? 'w' : 'b';
  const routeLineId = snapshot.routeLineId ?? snapshot.scheduledLineId;
  const line = repertoire.lines.find((item) => item.id === routeLineId);
  const lineIndex = Math.max(0, repertoire.lines.findIndex((item) => item.id === routeLineId));
  const scheduledIndex = Math.max(0, repertoire.lines.findIndex((item) => item.id === snapshot.scheduledLineId));
  const visibleMoveIds = activeAnnotation
    ? snapshot.actualMoveIds.slice(0, activeAnnotation.historyLength)
    : snapshot.actualMoveIds;
  const history = useMemo(
    () => visibleMoveIds.flatMap((moveId) => repertoire.moves[moveId]?.san ?? []),
    [repertoire.moves, visibleMoveIds],
  );
  const isReview = snapshot.phase === 'mistake-review';
  const hadReview = snapshot.mistakeLineIds.length > 0;
  const progress = repertoire.lines.length
    ? Math.round(((repertoire.lines.length - snapshot.initialRemaining) / repertoire.lines.length) * 100)
    : 100;
  const phase: TrainerPhase = activeAnnotation
    ? 'note'
    : snapshot.status === 'complete'
      ? 'complete'
      : revealed
        ? 'retry'
        : correctFeedback
          ? 'correct'
          : snapshot.status === 'awaiting-user'
            ? 'awaiting'
            : 'moving';

  useEffect(() => {
    if (snapshot.status !== 'line-complete' || activeAnnotation) return;
    const timer = window.setTimeout(() => {
      const transition = trainer.continue();
      setSnapshot(transition.snapshot);
      setAnnotationMoments(studyAnnotationMomentsForTransition(transition, repertoire));
      setSelected(null);
      setRevealed(null);
      setKnownAvoidMove(null);
      setCorrectFeedback(null);
      setLastMoveUci(null);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeAnnotation, repertoire, snapshot.status, trainer]);

  useEffect(() => {
    if (!correctFeedback) return;
    const timer = window.setTimeout(() => setCorrectFeedback(null), 420);
    return () => window.clearTimeout(timer);
  }, [correctFeedback]);

  const applyAcceptedTransition = useCallback((transition: TrainerTransition) => {
    const accepted = transition.events.find((event) => event.type === 'user-move-accepted');
    if (!accepted || accepted.type !== 'user-move-accepted') return false;
    const finalMove = [...transition.events].reverse().find(
      (event) => event.type === 'user-move-accepted' || event.type === 'opponent-move',
    );
    const nextAnnotationMoments = studyAnnotationMomentsForTransition(transition, repertoire);
    setSnapshot(transition.snapshot);
    setAnnotationMoments(nextAnnotationMoments);
    setCorrectFeedback(nextAnnotationMoments.length > 0 ? null : accepted.alternative ? 'alternative' : 'target');
    setRevealed(null);
    setKnownAvoidMove(null);
    setSelected(null);
    setLastMoveUci(finalMove && 'move' in finalMove ? finalMove.move.uci : accepted.move.uci);
    setCorrectCount((value) => value + 1);
    return true;
  }, [repertoire]);

  const tryMove = useCallback((from: string, to: string | null): boolean => {
    if (activeAnnotation || !to || snapshot.status !== 'awaiting-user' || !snapshot.prompt) return false;
    const prefix = `${from}${to}`.toLowerCase();
    const promotionMove = snapshot.prompt.acceptedMoves.find((move) => move.uci.startsWith(prefix));
    const transition = trainer.submitUserMove({ from, to, promotion: promotionMove?.uci[4] });
    const incorrect = transition.events.find((event) => event.type === 'incorrect-move');
    if (incorrect?.type === 'incorrect-move') {
      setWrongCount((value) => value + 1);
      setRevealed(incorrect.correction.correctMove);
      setKnownAvoidMove(incorrect.correction.knownAvoidMove ?? null);
      setCorrectFeedback(null);
      setSelected(null);
      // Keep the correction visible while returning the engine to its mandatory
      // direct-retry state. The graph position itself is deliberately unchanged.
      setSnapshot(trainer.acknowledgeCorrection().snapshot);
      return false;
    }
    if (transition.events.some((event) => event.type === 'illegal-move')) {
      setSelected(null);
      return false;
    }
    return applyAcceptedTransition(transition);
  }, [activeAnnotation, applyAcceptedTransition, snapshot.prompt, snapshot.status, trainer]);

  const handleSquareClick = useCallback(({ square }: { square: string }) => {
    if (activeAnnotation || snapshot.status !== 'awaiting-user' || correctFeedback) return;
    const game = new Chess(snapshot.fen);
    const piece = game.get(square as never);
    if (!selected) {
      if (piece?.color === userColor) setSelected(square);
      return;
    }
    if (piece?.color === userColor) {
      setSelected(square);
      return;
    }
    tryMove(selected, square);
  }, [activeAnnotation, correctFeedback, selected, snapshot.fen, snapshot.status, tryMove, userColor]);

  const handleContinueAnnotation = useCallback(() => {
    setAnnotationMoments((moments) => moments.slice(1));
  }, []);

  const displayFen = activeAnnotation?.fen ?? snapshot.fen;
  const displayLastMoveUci = activeAnnotation?.uci ?? lastMoveUci;

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    for (const square of activeAnnotation?.squares ?? []) {
      styles[square.square] = { backgroundColor: square.color };
    }
    if (selected) styles[selected] = { boxShadow: 'inset 0 0 0 5px rgba(244, 184, 96, .9)' };
    if (phase === 'correct' && displayLastMoveUci) {
      styles[displayLastMoveUci.slice(0, 2)] = { background: 'rgba(78, 203, 177, .5)' };
      styles[displayLastMoveUci.slice(2, 4)] = { background: 'rgba(78, 203, 177, .62)' };
    }
    return styles;
  }, [activeAnnotation, displayLastMoveUci, phase, selected]);

  const arrows: Arrow[] = activeAnnotation
    ? activeAnnotation.arrows
    : revealed
      ? [{ startSquare: revealed.uci.slice(0, 2), endSquare: revealed.uci.slice(2, 4), color: '#f0695f' }]
      : [];
  const knownAvoidComments = knownAvoidMove?.annotations.comments
    .map((comment) => comment.trim())
    .filter(Boolean)
    .join(' · ');
  const promptText = phase === 'retry'
    ? knownAvoidMove
      ? '연구에서 피하라고 표시한 수예요'
      : `${revealed?.san ?? '정답 수'}를 두고 다시 기억하세요`
    : phase === 'correct'
      ? correctFeedback === 'alternative' ? '좋아요, 등록된 다른 분기도 정답입니다' : '좋아요, 정확합니다'
      : snapshot.status === 'line-complete'
        ? '다음 라인을 준비하고 있어요…'
        : isReview
          ? '틀렸던 수를 다시 찾아보세요'
          : `${chapter.orientation === 'white' ? '백' : '흑'}의 수를 두세요`;

  if (!line && phase !== 'complete') return <div className="trainer-error"><p>훈련할 라인이 없습니다.</p><button className="button" onClick={onBack}>돌아가기</button></div>;

  if (phase === 'complete') {
    return (
      <main className="completion page-shell">
        <div className="completion-card">
          <span className="completion-mark"><Icon name="check" size={42} /></span>
          <span className="eyebrow">CHAPTER COMPLETE</span>
          <h1>{hadReview ? '오답까지 깨끗하게 끝냈어요.' : '챕터 훈련을 마쳤어요.'}</h1>
          <p>{chapter.name}</p>
          <div className="result-grid"><div><strong>{repertoire.lines.length}</strong><small>학습 라인</small></div><div><strong>{wrongCount}</strong><small>틀린 횟수</small></div><div><strong>{snapshot.mistakeLineIds.length}</strong><small>오답 복습 라인</small></div></div>
          <button className="button button-primary" onClick={onBack}>라이브러리로 돌아가기 <Icon name="arrow" /></button>
        </div>
      </main>
    );
  }

  const canMove = snapshot.status === 'awaiting-user' && !correctFeedback && !activeAnnotation;
  const boardOptions = {
    id: `trainer-${chapter.id}`,
    position: displayFen,
    boardOrientation: chapter.orientation,
    allowDragging: canMove,
    allowDrawingArrows: false,
    showNotation: true,
    animationDurationInMs: 260,
    darkSquareStyle: { backgroundColor: '#567577' },
    lightSquareStyle: { backgroundColor: '#e8e1cf' },
    boardStyle: { borderRadius: '6px', boxShadow: '0 22px 60px rgba(6, 15, 27, .33)' },
    squareStyles,
    arrows,
    canDragPiece: ({ square }: { square: string | null }) => {
      if (!square || !canMove) return false;
      return new Chess(displayFen).get(square as never)?.color === userColor;
    },
    onPieceDrop: ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => tryMove(sourceSquare, targetSquare),
    onSquareClick: handleSquareClick,
  } as const;

  return (
    <main className="trainer-shell">
      <div className="trainer-topline">
        <button className="back-button" onClick={onBack}><Icon name="back" size={18} /> 라이브러리</button>
        <div className="trainer-title"><small>{isReview ? `오답 복습 · ${snapshot.reviewRemaining}라인 남음` : chapter.orientation === 'white' ? '백 레퍼토리' : '흑 레퍼토리'}</small><strong>{chapter.name}</strong></div>
        <div className="trainer-counter">{isReview ? <><span>{snapshot.reviewRemaining}</span> 남음</> : <><span>{scheduledIndex + 1}</span> / {repertoire.lines.length}</>}</div>
      </div>
      <div className="session-progress"><i style={{ width: `${progress}%` }} /></div>

      <div className="trainer-layout">
        <section className="board-column" aria-label="체스판">
          <div className={`board-frame phase-${phase}`}><Chessboard options={boardOptions} /></div>
          {activeAnnotation ? (
            <div className="feedback feedback-note" role="status" aria-live="polite">
              <span className="feedback-symbol">✎</span>
              <div className="study-note-copy">
                <strong>리체스 연구 메모 · {activeAnnotation.san ? `${activeAnnotation.san} 뒤` : '시작 포지션'}</strong>
                {activeAnnotation.comments.map((comment, index) => <p key={`${index}:${comment}`}>{comment}</p>)}
                {(activeAnnotation.arrows.length > 0 || activeAnnotation.squares.length > 0) && <small>연구에 표시한 화살표와 강조 칸을 보드에 표시했습니다.</small>}
              </div>
              <button className="study-note-button" type="button" onClick={handleContinueAnnotation}>
                {annotationMoments.length > 1 ? '다음 메모' : '계속'} <Icon name="arrow" size={15} />
              </button>
            </div>
          ) : (
            <div className={`feedback feedback-${phase}`} role="status" aria-live="polite">
              <span className="feedback-symbol">{phase === 'retry' ? '!' : phase === 'correct' ? '✓' : chapter.orientation === 'white' ? '♙' : '♟'}</span>
              <div><strong>{promptText}</strong><small>{phase === 'retry' ? knownAvoidComments || '정답 화살표를 확인한 뒤 같은 수를 직접 두세요.' : phase === 'correct' ? '레퍼토리 그래프를 따라 다음 포지션으로 넘어갑니다.' : '기물을 드래그하거나 출발 칸과 도착 칸을 누르세요.'}</small></div>
            </div>
          )}
        </section>

        <aside className="session-panel">
          <div className="line-label"><span>현재 라인</span><strong>{`${lineIndex + 1}번 라인`}</strong></div>
          <div className="move-sheet">
            {history.length === 0 && <div className="move-placeholder">첫 수를 떠올려 보세요.</div>}
            {Array.from({ length: Math.ceil(history.length / 2) }, (_, index) => (
              <div className="move-row" key={index}><span>{index + 1}.</span><strong>{history[index * 2]}</strong><strong>{history[index * 2 + 1] ?? ''}</strong></div>
            ))}
            {phase === 'retry' && <div className="answer-reveal"><small>정답</small><strong>{revealed?.san}</strong></div>}
          </div>
          <div className="session-stats">
            <div><small>진행</small><strong>{progress}%</strong></div>
            <div><small>정답</small><strong>{correctCount}</strong></div>
            <div><small>실수</small><strong className={wrongCount ? 'danger' : ''}>{wrongCount}</strong></div>
          </div>
          <div className="trainer-tip"><Icon name="spark" size={18} /><p><strong>정답은 직접 다시 두기</strong><br />눈으로 확인하는 데서 끝내지 않아야 기억이 단단해집니다.</p></div>
        </aside>
      </div>
    </main>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus>({ connected: false });
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [activeChapter, setActiveChapter] = useState<ChapterDetail | null>(null);
  const [practiceOpen, setPracticeOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<SyncResult | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const loadLibrary = useCallback(async (status: AuthStatus) => {
    try {
      setLibrary(await getLibrary(status.connected));
      setLibraryError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '연구 목록 요청에 실패했습니다.';
      // A connected-account failure must stay visible and must never be disguised
      // as the disconnected sample library.
      setLibrary({ studies: [], sample: false });
      setLibraryError(message);
      setToast({ message: `연구 목록을 불러오지 못했습니다: ${message}`, tone: 'error' });
      return false;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const status = await getAuthStatus();
      setAuth(status);
      await loadLibrary(status);
      const callback = new URLSearchParams(window.location.search).get('lichess');
      if (callback) {
        window.history.replaceState({}, '', window.location.pathname);
        if (callback === 'connected' && status.connected) {
          setToast({ message: 'Lichess 연결 완료 · 연구를 가져오는 중입니다.', tone: 'success' });
          setSyncing(true);
          try {
            const result = await syncStudies();
            const loaded = await loadLibrary(status);
            setSyncReport(result);
            setLastSync(new Date(result.lastSyncAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
            const summary = `가져옴 ${result.imported} · 변경 없음 ${result.skipped} · 실패 ${result.failed}`;
            setToast({ message: loaded ? summary : `${summary} · 목록 새로고침 실패`, tone: result.failed || !loaded ? 'error' : 'success' });
          } catch (error) {
            const message = error instanceof Error ? error.message : '연구 동기화를 다시 눌러 주세요.';
            setToast({ message: `연결은 완료했지만 연구를 가져오지 못했습니다: ${message}`, tone: 'error' });
          } finally {
            setSyncing(false);
          }
        } else {
          setToast({ message: 'Lichess 연결을 완료하지 못했습니다.', tone: 'error' });
        }
      }
    })();
  }, [loadLibrary]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const handleLogin = async () => {
    setBusy(true);
    try { await beginLogin(); }
    catch { setToast({ message: 'Lichess 연결을 시작하지 못했습니다.', tone: 'error' }); setBusy(false); }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await logout();
      const status = { connected: false };
      setAuth(status);
      setSyncReport(null);
      await loadLibrary(status);
      setToast({ message: '연결을 해제했습니다. 동기화된 연구는 이 기기에 남아 있습니다.', tone: 'success' });
    } catch { setToast({ message: '연결 해제에 실패했습니다.', tone: 'error' }); }
    finally { setBusy(false); }
  };

  const handleSync = async () => {
    if (!auth.connected) { await handleLogin(); return; }
    setSyncing(true);
    setSyncReport(null);
    try {
      const result = await syncStudies();
      const loaded = await loadLibrary(auth);
      setSyncReport(result);
      setLastSync(new Date(result.lastSyncAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
      const summary = `가져옴 ${result.imported} · 변경 없음 ${result.skipped} · 실패 ${result.failed}`;
      setToast({ message: loaded ? summary : `${summary} · 목록 새로고침 실패`, tone: result.failed || !loaded ? 'error' : 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.';
      setToast({ message: `동기화하지 못했습니다: ${message}`, tone: 'error' });
    }
    finally { setSyncing(false); }
  };

  const handleTrain = async (summary: ChapterSummary) => {
    setBusy(true);
    try { setActiveChapter(await getChapter(summary, Boolean(library?.sample))); }
    catch (error) { setToast({ message: error instanceof Error ? error.message : '챕터를 열지 못했습니다.', tone: 'error' }); }
    finally { setBusy(false); }
  };

  const handlePractice = () => {
    setPracticeOpen(true);
  };

  const handleReview = () => {
    setReviewOpen(true);
  };

  if (!library) return <div className="app-loading"><Mark /><span>훈련실을 준비하고 있어요</span></div>;

  return (
    <div className="app">
      {!activeChapter && !practiceOpen && !reviewOpen && <Header auth={auth} onLogin={handleLogin} onLogout={handleLogout} busy={busy} />}
      {activeChapter
        ? <TrainerScreen chapter={activeChapter} onBack={() => setActiveChapter(null)} />
        : practiceOpen
          ? <OpeningPractice onBack={() => setPracticeOpen(false)} lichessConnected={auth.connected} />
          : reviewOpen
            ? <ChessComReview onBack={() => setReviewOpen(false)} />
            : <LibraryScreen library={library} auth={auth} syncing={syncing} lastSync={lastSync} libraryError={libraryError} syncReport={syncReport} onSync={handleSync} onTrain={handleTrain} onPractice={handlePractice} onReview={handleReview} />}
      {busy && !activeChapter && !practiceOpen && !reviewOpen && <div className="busy-overlay" aria-label="불러오는 중"><span /></div>}
      {toast && <div className={`toast toast-${toast.tone}`} role="status"><Icon name={toast.tone === 'success' ? 'check' : 'target'} />{toast.message}</div>}
    </div>
  );
}
