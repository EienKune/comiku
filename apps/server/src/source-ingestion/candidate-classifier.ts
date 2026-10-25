import type { CandidateVisualClass } from "../generated/prisma/client.js";

export interface CandidateClassificationInput {
  candidateId: string;
  media: { fileObjectId: string; contentType: string }[];
}

export interface CandidateClassificationResult {
  label: CandidateVisualClass;
  score: number;
  classifierName: string;
  classifierVersion: string;
}

export interface CandidateMediaClassifier {
  readonly available: boolean;
  classify(
    input: CandidateClassificationInput,
  ): Promise<CandidateClassificationResult | null>;
}

export class DisabledCandidateMediaClassifier implements CandidateMediaClassifier {
  readonly available = false;
  async classify(): Promise<null> {
    return null;
  }
}

export const CANDIDATE_MEDIA_CLASSIFIER = Symbol("CANDIDATE_MEDIA_CLASSIFIER");
