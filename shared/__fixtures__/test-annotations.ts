export const annotationCases = [
  { source: '@req-ORDER-1 @variant-email-link checkout', title: 'checkout', tags: ['@req-ORDER-1', '@variant-email-link'] },
  { source: 'checkout @req-Order_1.2 @path-sad', title: 'checkout', tags: ['@req-Order_1.2', '@path-sad'] },
  { source: '@req-R1 @req-R1 checkout', title: 'checkout', tags: ['@req-R1', '@req-R1'] },
  { source: 'checkout @req- @ broken', title: 'checkout @req- @ broken', tags: [] },
  { source: 'checkout (@variant-email-link)', title: 'checkout ()', tags: ['@variant-email-link'] },
]
