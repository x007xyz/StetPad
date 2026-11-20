export const nonAsciiFixtures = [
  { name: 'Chinese', title: '中文标题', content: '中文段落，内容保持不变。', queries: ['中文', '标题'], bodyQuery: '中文', caseContent: '中文段落，内容保持不变。' },
  { name: 'accents', title: 'Café Résumé Ü Ñ', content: 'Café Résumé Ü Ñ', queries: ['café', 'CAFÉ', 'résumé', 'ü', 'ñ'], bodyQuery: 'café', caseContent: 'CAFÉ RÉSUMÉ Ü Ñ' },
  { name: 'German sharp s', title: 'Straße', content: 'Straße', queries: ['straße', 'STRAßE'], bodyQuery: 'straße', caseContent: 'STRAßE' },
  { name: 'Turkish dotted and dotless i', title: 'İstanbul ıslak', content: 'İstanbul ıslak', queries: ['İSTANBUL', 'ıslak'], bodyQuery: 'ıslak', caseContent: 'İSTANBUL ıslak' },
] as const
