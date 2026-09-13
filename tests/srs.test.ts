import { describe, expect, it } from "vitest";

import {
  ChapterTrainer,
  InvalidSrsProgressError,
  SRS_AGAIN_DELAY_MS,
  SRS_DAY_MS,
  SRS_GOOD_INTERVAL_DAYS,
  applySessionCardGrades,
  createSrsProgress,
  deserializeSrsProgress,
  getChapterSrsSummary,
  getGlobalSrsSummary,
  getStudySrsSummary,
  gradeSrsCard,
  importLichessStudyPgn,
  listChapterSrsCards,
  listDueSrsCards,
  parseSrsProgress,
  serializeSrsProgress,
  type RepertoireChapter,
  type SessionCardGrade,
  type SrsProgress,
} from "../shared/index.js";

function chapterPgn(
  moves: string,
  options: {
    studyId?: string;
    chapterId?: string;
    chapterName?: string;
    orientation?: "white" | "black";
  } = {},
): string {
  const studyId = options.studyId ?? "srs-study";
  const chapterId = options.chapterId ?? "srs-chapter";
  return `[Event "SRS fixture"]
[Site "https://lichess.org/study/${studyId}/${chapterId}"]
[StudyName "SRS study"]
[ChapterName "${options.chapterName ?? "SRS chapter"}"]
[ChapterURL "https://lichess.org/study/${studyId}/${chapterId}"]
[Orientation "${options.orientation ?? "white"}"]
[Result "*"]

${moves}`;
}

function makeChapter(
  moves = "1. e4 e5 2. Nf3 Nc6 3. Bb5 *",
  options: Parameters<typeof chapterPgn>[1] = {},
): RepertoireChapter {
  return importLichessStudyPgn(chapterPgn(moves, options)).chapters[0];
}

function sessionGrade(
  cardId: string,
  grade: "again" | "good",
  lastAttemptAt: number,
  responseMs = 250,
): SessionCardGrade {
  return {
    cardId,
    grade,
    firstAttemptAt: Math.max(0, lastAttemptAt - responseMs),
    lastAttemptAt,
    totalResponseMs: responseMs,
  };
}

function gradeOnce(
  progress: SrsProgress,
  chapter: RepertoireChapter,
  cardId: string,
  grade: "again" | "good",
  at: number,
): SrsProgress {
  return applySessionCardGrades(
    progress,
    chapter,
    [sessionGrade(cardId, grade, at)],
    at,
  );
}

describe("persistent SRS scheduling", () => {
  it("creates a durable card record from a trainer Good grade", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    const empty = createSrsProgress(1_000);
    const grade = sessionGrade(cardId, "good", 2_000, 300);

    const progress = applySessionCardGrades(empty, chapter, [grade], 2_500);

    expect(empty.cards).toEqual({});
    expect(progress.updatedAt).toBe(2_500);
    expect(progress.cards[cardId]).toEqual({
      cardId,
      studyId: chapter.studyId,
      chapterId: chapter.id,
      firstReviewedAt: 1_700,
      lastReviewedAt: 2_000,
      dueAt: 2_000 + SRS_DAY_MS,
      intervalDays: 1,
      reviewCount: 1,
      successCount: 1,
      lapseCount: 0,
      consecutiveGood: 1,
      mastery: 20,
      totalResponseMs: 300,
      lastGrade: "good",
    });
  });

  it("advances through the Good interval ladder and caps long-term reviews", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    let progress = createSrsProgress(0);
    const observedIntervals: number[] = [];
    let at = 1_000;

    for (let index = 0; index < SRS_GOOD_INTERVAL_DAYS.length + 2; index += 1) {
      progress = gradeOnce(progress, chapter, cardId, "good", at);
      observedIntervals.push(progress.cards[cardId].intervalDays);
      expect(progress.cards[cardId].dueAt).toBe(
        at + progress.cards[cardId].intervalDays * SRS_DAY_MS,
      );
      at += 1_000;
    }

    expect(observedIntervals).toEqual([
      ...SRS_GOOD_INTERVAL_DAYS,
      SRS_GOOD_INTERVAL_DAYS.at(-1),
      SRS_GOOD_INTERVAL_DAYS.at(-1),
    ]);
    expect(progress.cards[cardId]).toMatchObject({
      consecutiveGood: SRS_GOOD_INTERVAL_DAYS.length + 2,
      mastery: 100,
      reviewCount: SRS_GOOD_INTERVAL_DAYS.length + 2,
      successCount: SRS_GOOD_INTERVAL_DAYS.length + 2,
      lapseCount: 0,
    });
  });

  it("puts Again into short relearning and restarts the interval ladder", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    let progress = createSrsProgress(0);
    for (let review = 1; review <= 5; review += 1) {
      progress = gradeOnce(progress, chapter, cardId, "good", review * 1_000);
    }
    expect(progress.cards[cardId].mastery).toBe(80);

    progress = gradeOnce(progress, chapter, cardId, "again", 10_000);
    expect(progress.cards[cardId]).toMatchObject({
      dueAt: 10_000 + SRS_AGAIN_DELAY_MS,
      intervalDays: 0,
      reviewCount: 6,
      successCount: 5,
      lapseCount: 1,
      consecutiveGood: 0,
      mastery: 45,
      lastGrade: "again",
    });

    progress = gradeOnce(progress, chapter, cardId, "good", 20_000);
    expect(progress.cards[cardId]).toMatchObject({
      dueAt: 20_000 + SRS_DAY_MS,
      intervalDays: 1,
      consecutiveGood: 1,
      mastery: 60,
      lastGrade: "good",
    });
  });

  it("is idempotent for an already-recorded grade and rejects invalid batches", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    const grade = sessionGrade(cardId, "good", 2_000);
    const context = { studyId: chapter.studyId, chapterId: chapter.id };
    const first = gradeSrsCard(undefined, context, grade);

    expect(gradeSrsCard(first, context, grade)).toEqual(first);
    expect(() =>
      applySessionCardGrades(
        createSrsProgress(0),
        chapter,
        [grade, { ...grade }],
        2_000,
      ),
    ).toThrow(/Duplicate session grade/);
    expect(() =>
      gradeSrsCard(undefined, context, {
        ...grade,
        firstAttemptAt: 3_000,
      }),
    ).toThrow(/cannot precede/);
    expect(() => createSrsProgress(Number.NaN)).toThrow(/finite timestamp/);
  });

  it("keeps an accepted repertoire alternative attached to its own stable card", () => {
    const chapter = makeChapter("1. e4 (1. d4 d5) e5 *");
    const trainer = new ChapterTrainer(chapter);
    const originalCardId = trainer.start(100).snapshot.prompt!.target.cardId!;

    trainer.submitUserMove("d2d4", 200);
    const grades = trainer.getSessionCardGrades();
    const alternativeCardId = grades[0].cardId;
    const progress = applySessionCardGrades(
      createSrsProgress(0),
      chapter,
      grades,
      200,
    );

    expect(alternativeCardId).not.toBe(originalCardId);
    expect(progress.cards[alternativeCardId]?.lastGrade).toBe("good");
    expect(progress.cards[originalCardId]).toBeUndefined();
  });
});

describe("SRS summaries and today's reviews", () => {
  it("separates unseen, due, learning, and future cards for a chapter", () => {
    const chapter = makeChapter();
    const [first, second] = listChapterSrsCards(chapter);
    let progress = createSrsProgress(0);
    progress = gradeOnce(progress, chapter, first.cardId, "good", 1_000);
    progress = gradeOnce(progress, chapter, second.cardId, "again", 2_000);
    const now = 2_000 + SRS_AGAIN_DELAY_MS + 1;

    expect(getChapterSrsSummary(chapter, progress, now)).toEqual({
      totalCards: 3,
      newCards: 1,
      reviewedCards: 2,
      dueCards: 1,
      learningCards: 2,
      masteredCards: 0,
      masteryPercent: 7,
      totalReviews: 2,
      totalLapses: 1,
      earliestDueAt: 2_000 + SRS_AGAIN_DELAY_MS,
      nextDueAt: 1_000 + SRS_DAY_MS,
    });

    expect(listDueSrsCards([chapter], progress, now)).toMatchObject([
      { cardId: second.cardId, record: { lastGrade: "again" } },
    ]);
  });

  it("aggregates a study globally, deduplicates repeated sources, and sorts by due time", () => {
    const study = importLichessStudyPgn(
      [
        chapterPgn("1. e4 e5 *", { chapterId: "chapter-a" }),
        chapterPgn("1. d4 d5 *", { chapterId: "chapter-b" }),
      ].join("\n\n"),
    );
    const [chapterA, chapterB] = study.chapters;
    const cardA = listChapterSrsCards(chapterA)[0];
    const cardB = listChapterSrsCards(chapterB)[0];
    let progress = createSrsProgress(0);
    progress = gradeOnce(progress, chapterA, cardA.cardId, "again", 2_000);
    progress = gradeOnce(progress, chapterB, cardB.cardId, "again", 1_000);
    const now = SRS_AGAIN_DELAY_MS + 3_000;

    expect(getStudySrsSummary(study, progress, now)).toMatchObject({
      totalCards: 2,
      reviewedCards: 2,
      dueCards: 2,
      totalLapses: 2,
    });
    expect(
      getGlobalSrsSummary([study, chapterA, chapterB], progress, now),
    ).toEqual(getStudySrsSummary(study, progress, now));
    expect(
      listDueSrsCards([chapterA, chapterB], progress, now).map(
        (card) => card.cardId,
      ),
    ).toEqual([cardB.cardId, cardA.cardId]);
  });

  it("recognizes progress after a chapter title or annotation is edited", () => {
    const before = makeChapter("1. e4 e5 *", { chapterName: "Before" });
    const after = makeChapter("1. e4 {New explanation.} e5 *", {
      chapterName: "After",
    });
    const originalCardId = listChapterSrsCards(before)[0].cardId;
    const progress = gradeOnce(
      createSrsProgress(0),
      before,
      originalCardId,
      "good",
      1_000,
    );

    expect(listChapterSrsCards(after)[0].cardId).toBe(originalCardId);
    expect(getChapterSrsSummary(after, progress, 2_000)).toMatchObject({
      totalCards: 1,
      newCards: 0,
      reviewedCards: 1,
      masteryPercent: 20,
    });
  });
});

describe("SRS persistence format", () => {
  it("round-trips validated JSON without sharing card objects", () => {
    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    const original = gradeOnce(
      createSrsProgress(0),
      chapter,
      cardId,
      "good",
      1_000,
    );

    const restored = deserializeSrsProgress(serializeSrsProgress(original));

    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(restored.cards[cardId]).not.toBe(original.cards[cardId]);
    restored.cards[cardId].mastery = 99;
    expect(original.cards[cardId].mastery).toBe(20);
  });

  it("rejects malformed, incompatible, and internally inconsistent data", () => {
    expect(() => deserializeSrsProgress("not json")).toThrow(
      InvalidSrsProgressError,
    );
    expect(() =>
      parseSrsProgress({ version: 2, updatedAt: 0, cards: {} }),
    ).toThrow(/Unsupported SRS progress version/);

    const chapter = makeChapter("1. e4 e5 *");
    const cardId = listChapterSrsCards(chapter)[0].cardId;
    const valid = gradeOnce(
      createSrsProgress(0),
      chapter,
      cardId,
      "good",
      1_000,
    );
    expect(() =>
      parseSrsProgress({
        ...valid,
        cards: { wrongKey: valid.cards[cardId] },
      }),
    ).toThrow(/does not match its ID/);
    expect(() =>
      parseSrsProgress({
        ...valid,
        cards: {
          [cardId]: { ...valid.cards[cardId], reviewCount: 99 },
        },
      }),
    ).toThrow(/inconsistent review counters/);
    expect(() => parseSrsProgress({ ...valid, updatedAt: 0 })).toThrow(
      /reviewed after progress was updated/,
    );
  });
});
