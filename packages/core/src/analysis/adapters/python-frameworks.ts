/**
 * SMI-1304: Python Framework Detection Rules
 *
 * Framework detection rules for common Python frameworks and libraries.
 * Extracted from python.ts for better modularity.
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import type { FrameworkRule } from './base.js'

/**
 * Python framework detection rules
 *
 * Detects common Python frameworks and libraries including:
 * - Web frameworks: Django, FastAPI, Flask
 * - Testing: pytest
 * - Data science: pandas, numpy
 * - Databases: SQLAlchemy
 * - Task queues: Celery
 */
export const PYTHON_FRAMEWORK_RULES: FrameworkRule[] = [
  {
    name: 'Django',
    depIndicators: ['django', 'Django'],
    importIndicators: ['django', 'django.db', 'django.http', 'django.views', 'django.urls'],
  },
  {
    name: 'FastAPI',
    depIndicators: ['fastapi'],
    importIndicators: ['fastapi', 'starlette', 'pydantic'],
  },
  {
    name: 'Flask',
    depIndicators: ['flask', 'Flask'],
    importIndicators: ['flask', 'flask_restful', 'flask_sqlalchemy'],
  },
  {
    name: 'pytest',
    depIndicators: ['pytest'],
    importIndicators: ['pytest', 'pytest_asyncio', '_pytest'],
  },
  {
    name: 'pandas',
    depIndicators: ['pandas'],
    importIndicators: ['pandas', 'pd'],
  },
  {
    name: 'numpy',
    depIndicators: ['numpy'],
    importIndicators: ['numpy', 'np'],
  },
  {
    name: 'SQLAlchemy',
    depIndicators: ['sqlalchemy', 'SQLAlchemy'],
    importIndicators: ['sqlalchemy', 'sqlalchemy.orm', 'sqlalchemy.ext'],
  },
  {
    name: 'Celery',
    depIndicators: ['celery'],
    importIndicators: ['celery', 'celery.task'],
  },
  {
    name: 'Requests',
    depIndicators: ['requests'],
    importIndicators: ['requests'],
  },
  {
    name: 'aiohttp',
    depIndicators: ['aiohttp'],
    importIndicators: ['aiohttp'],
  },
  {
    name: 'Scrapy',
    depIndicators: ['scrapy'],
    importIndicators: ['scrapy'],
  },
  {
    name: 'TensorFlow',
    depIndicators: ['tensorflow', 'tensorflow-gpu'],
    importIndicators: ['tensorflow', 'tf'],
  },
  {
    name: 'PyTorch',
    depIndicators: ['torch', 'pytorch'],
    importIndicators: ['torch', 'torch.nn', 'torchvision'],
  },
]
