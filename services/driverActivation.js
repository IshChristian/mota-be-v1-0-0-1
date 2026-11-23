const User = require('../models/User');
const DriverKyc = require('../models/DriverKyc');
// Approval is a one-time onboarding transition, never a way to undo a suspension.
async function activateFullKycDriver(user, options = {}) {
  if (!user || user.role !== 'driver' || user.kycLevel !== 'full' || user.deletedAt || user.activationBlocked || user.registrationStatus === 'approved') return user;
  // A submitted KYC is approved by staff only: an account level of "full" is not enough.
  // Accounts from before DriverKyc existed have no record and keep their verified status.
  const kyc = await DriverKyc.findOne({userId:user._id}).select('status').session(options.session || null).lean();
  if (kyc && kyc.status !== 'approved') return user;
  const updated = await User.findOneAndUpdate({_id:user._id, role:'driver',kycLevel:'full',registrationStatus:{$ne:'approved'},deletedAt:null,activationBlocked:{$ne:true}},{$set:{isActive:true,registrationStatus:'approved'}},{new:true,...options});
  if(updated){user.isActive=updated.isActive;user.registrationStatus=updated.registrationStatus;}
  return user;
}
module.exports={activateFullKycDriver};
