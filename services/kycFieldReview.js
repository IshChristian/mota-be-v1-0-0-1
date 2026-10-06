function validateFieldReviews(fields, record, reviews, status) {
  if(!Array.isArray(reviews))throw Object.assign(new Error('Field reviews must be an array.'),{status:400});
  const seen=new Set();
  const normalized=reviews.map(review=>{
    if(!review||!fields.includes(review.key)||seen.has(review.key)||!['approved','correction'].includes(review.status))throw Object.assign(new Error('Invalid or duplicate KYC field review.'),{status:400});
    seen.add(review.key);
    if(record[review.key]===undefined||record[review.key]===null||record[review.key]==='')throw Object.assign(new Error('Only submitted values can be reviewed.'),{status:400});
    const reason=String(review.reason||'').trim();
    if(review.status==='correction'&&reason.length<5)throw Object.assign(new Error('Each correction needs a reason of at least five characters.'),{status:400});
    if(reason.length>1000)throw Object.assign(new Error('Correction reasons must be at most 1000 characters.'),{status:400});
    return {key:review.key,status:review.status,reason};
  });
  if(status==='approved'&&fields.some(key=>record[key]!==undefined&&record[key]!==null&&record[key]!==''&&!normalized.some(r=>r.key===key&&r.status==='approved')))throw Object.assign(new Error('Approve every submitted field before approving KYC.'),{status:400});
  if(status==='approved'&&fields.some(key=>key.endsWith('ExpiresAt')&&record[key]&&new Date(record[key]).getTime()<=Date.now()))throw Object.assign(new Error('Expired documents cannot be approved.'),{status:400});
  return normalized;
}
module.exports={validateFieldReviews};
