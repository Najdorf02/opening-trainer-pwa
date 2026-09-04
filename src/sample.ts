import { importLichessStudyPgn } from '../shared/pgn.js';
import type { RepertoireChapter, RepertoireMove } from '../shared/repertoire.js';
import type { ChapterDetail, LibraryPayload, MoveSpec, StudySummary, TrainingLine } from './types';

const WHITE_SAMPLE_PGN = `[Event "Opening Room sample"]
[Site "https://lichess.org/study/sample-white/sample-ruy"]
[StudyName "1.e4 · 백 레퍼토리"]
[ChapterName "스페인 게임 · 메인 라인"]
[ChapterURL "https://lichess.org/study/sample-white/sample-ruy"]
[Orientation "white"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 (3... Nf6 4. O-O Nxe4 5. d4 Nd6 6. Bxc6 dxc6) 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *

[Event "Opening Room sample"]
[Site "https://lichess.org/study/sample-white/sample-open-sicilian"]
[StudyName "1.e4 · 백 레퍼토리"]
[ChapterName "오픈 시실리안 진입"]
[ChapterURL "https://lichess.org/study/sample-white/sample-open-sicilian"]
[Orientation "white"]
[Result "*"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 *`;

const BLACK_SAMPLE_PGN = `[Event "Opening Room sample"]
[Site "https://lichess.org/study/sample-black/sample-najdorf"]
[StudyName "검은 기물 · 실전 방어"]
[ChapterName "나이도프 · 6.Be3"]
[ChapterURL "https://lichess.org/study/sample-black/sample-najdorf"]
[Orientation "black"]
[Result "*"]

1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be3 e5 7. Nb3 Be6 *

[Event "Opening Room sample"]
[Site "https://lichess.org/study/sample-black/sample-caro"]
[StudyName "검은 기물 · 실전 방어"]
[ChapterName "카로칸 · 클래시컬"]
[ChapterURL "https://lichess.org/study/sample-black/sample-caro"]
[Orientation "black"]
[Result "*"]

1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 *`;

function moveSpec(move: RepertoireMove | undefined): MoveSpec {
  if (!move) throw new Error('샘플 레퍼토리의 수 참조가 올바르지 않습니다.');
  const promotion = move.uci[4] as MoveSpec['promotion'] | undefined;
  return {
    from: move.uci.slice(0, 2),
    to: move.uci.slice(2, 4),
    san: move.san,
    ...(promotion ? { promotion } : {}),
  };
}

function legacyLines(chapter: RepertoireChapter): TrainingLine[] {
  return [...chapter.lines]
    .sort((left, right) => left.order - right.order)
    .map((line) => ({
      id: line.id,
      initialFen: chapter.rootFen,
      moves: line.moveIds.map((moveId) => moveSpec(chapter.moves[moveId])),
    }));
}

function chapterDetail(chapter: RepertoireChapter): ChapterDetail {
  const lines = legacyLines(chapter);
  return {
    id: chapter.id,
    studyId: chapter.studyId,
    name: chapter.name,
    orientation: chapter.repertoireColor,
    cardCount: new Set(Object.values(chapter.moves).flatMap((move) => move.cardId ? [move.cardId] : [])).size,
    lineCount: lines.length,
    repertoire: chapter,
    lines,
  };
}

const whiteStudy = importLichessStudyPgn(WHITE_SAMPLE_PGN, {
  studyId: 'sample-white',
  studyName: '1.e4 · 백 레퍼토리',
});
const blackStudy = importLichessStudyPgn(BLACK_SAMPLE_PGN, {
  studyId: 'sample-black',
  studyName: '검은 기물 · 실전 방어',
});
const sampleChapters = Object.fromEntries(
  [...whiteStudy.chapters, ...blackStudy.chapters]
    .map(chapterDetail)
    .map((chapter) => [chapter.id, chapter]),
);

function studySummary(id: string, name: string, chapterIds: string[]): StudySummary {
  const chapters = chapterIds.map((chapterId) => {
    const { repertoire: _repertoire, lines: _lines, ...summary } = sampleChapters[chapterId];
    return summary;
  });
  return { id, name, orientation: chapters[0]?.orientation, chapters };
}

export const sampleLibrary: LibraryPayload = {
  sample: true,
  studies: [
    studySummary('sample-white', whiteStudy.name, ['sample-ruy', 'sample-open-sicilian']),
    studySummary('sample-black', blackStudy.name, ['sample-najdorf', 'sample-caro']),
  ],
};

export function getSampleChapter(chapterId: string): ChapterDetail | undefined {
  return sampleChapters[chapterId];
}
