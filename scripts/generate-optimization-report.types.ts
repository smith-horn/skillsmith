/**
 * Types and constants for generate-optimization-report.
 *
 * Extracted from generate-optimization-report.ts to keep the main file
 * under the 500-line pre-commit cap.
 */

export interface FileSizeReduction {
  wave: number
  files: number
  beforeAvgLines: number
  afterAvgLines: number
  reductionPercent: number
}

export interface TransformationValidation {
  skillName: string
  originalLines: number
  optimizedLines: number
  lineReductionPercent: number
  predictedTokenReduction: number
  subSkillCount: number
  valid: boolean
}

export interface ABTestSummary {
  skillName: string
  predictedReduction: number
  actualReduction: number
  variance: number
  withinTolerance: boolean
}

export interface OptimizationReport {
  metadata: {
    generatedAt: string
    generatedBy: string
    projectVersion: string
    nodeVersion: string
  }
  fileSizeReduction: {
    summary: {
      totalFilesReduced: number
      avgReductionPercent: number
      newModulesCreated: number
    }
    waves: FileSizeReduction[]
  }
  transformationValidation: {
    summary: {
      skillsValidated: number
      avgPredictedReduction: number
      avgLineReduction: number
      allValid: boolean
    }
    results: TransformationValidation[]
  }
  abTests?: {
    summary: {
      testsRun: number
      avgVariance: number
      withinTolerancePercent: number
    }
    results: ABTestSummary[]
  }
  conclusions: {
    predictedVsActualAnalysis: string
    recommendations: string[]
    overallConfidence: 'high' | 'medium' | 'low'
  }
}

// SMI-1686 results (from docs/execution/smi-1686-file-size-reduction-plan.md)
export const SMI_1686_RESULTS: FileSizeReduction[] = [
  { wave: 1, files: 3, beforeAvgLines: 1295, afterAvgLines: 485, reductionPercent: 63 },
  { wave: 2, files: 5, beforeAvgLines: 868, afterAvgLines: 377, reductionPercent: 57 },
  { wave: 3.1, files: 3, beforeAvgLines: 738, afterAvgLines: 425, reductionPercent: 42 },
  { wave: 3.2, files: 5, beforeAvgLines: 640, afterAvgLines: 333, reductionPercent: 48 },
]
