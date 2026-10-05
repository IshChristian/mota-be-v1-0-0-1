const User = require('../models/User');
// Approval is a one-time onboarding transition, never a way to undo a suspension.
async function activateFullKycDriver(user) {
  if (!user || user.role !== 'driver' || user.kycLevel !== 'full' || user.deletedAt || user.activationBlocked || user.registrationStatus === 'approved') return user;
  const updated = await User.findOneAndUpdate({_id:user._id, role:'driver',kycLevel:'full',registrationStatus:{$ne:'approved'},deletedAt:null,activationBlocked:{$ne:true}},{$set:{isActive:true,registrationStatus:'approved'}},{new:true});
  if(updated){user.isActive=updated.isActive;user.registrationStatus=updated.registrationStatus;}
  return user;
}
module.exports={activateFullKycDriver};
