import React from 'react';
import type { SearchResult } from '@/shared/types';

interface SearchResultCardProps {
  readonly result: SearchResult;
  readonly isRecommended?: boolean;
}

export function SearchResultCard({ result, isRecommended }: SearchResultCardProps) {
  const { bookmark, hybridScore } = result;

  return (
    <a
      href={bookmark.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-3 bg-white rounded-lg border border-gray-200 hover:border-primary hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between">
        <h3 className="text-sm font-medium text-gray-800 truncate flex-1">
          {isRecommended && <span className="text-yellow-500 mr-1">⭐</span>}
          {bookmark.title || 'Untitled'}
        </h3>
        <span className="text-xs text-gray-400 ml-2">
          {Math.round(hybridScore * 100)}%
        </span>
      </div>
      <p className="text-xs text-blue-500 truncate mt-1">{bookmark.url}</p>
      {bookmark.path && (
        <p className="text-xs text-gray-400 mt-1">📁 {bookmark.path}</p>
      )}
    </a>
  );
}
