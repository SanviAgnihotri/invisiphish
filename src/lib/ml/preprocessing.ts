export const preprocessText = (text: string): string => {
  // Normalize text while preserving URLs
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlPattern) || [];
  
  // Replace URLs with placeholders
  let processedText = text;
  urls.forEach((url, i) => {
    processedText = processedText.replace(url, `__URL${i}__`);
  });
  
  // Clean text
  processedText = processedText
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Restore URLs
  urls.forEach((url, i) => {
    processedText = processedText.replace(`__url${i}__`, url);
  });
  
  return processedText;
};

export const extractFeatures = (text: string) => {
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlPattern) || [];
  
  const words = text.split(/\s+/);
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to']);
  const keywords = words.filter(word => !stopWords.has(word.toLowerCase()));
  
  return {
    urls,
    keywords,
    wordCount: words.length,
    hasUrls: urls.length > 0,
    containsUrgentWords: /urgent|immediate|now|asap|quickly/i.test(text),
    containsFinancialTerms: /money|bank|account|credit|debit|payment/i.test(text)
  };
};