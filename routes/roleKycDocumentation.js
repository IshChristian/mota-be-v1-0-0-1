// OpenAPI documentation for the role and KYC contracts. Runtime handlers live in roleRoutes/adminRoutes.
/**
 * @swagger
 * components:
 *   schemas:
 *     KycFieldDecision:
 *       type: object
 *       required: [key, status]
 *       properties:
 *         key:
 *           type: string
 *           description: A submitted field key returned in the requirements array.
 *         status:
 *           type: string
 *           enum: [approved, correction]
 *         reason:
 *           type: string
 *           maxLength: 1000
 *           description: At least five trimmed characters when correction is required.
 *     KycReviewRequest:
 *       type: object
 *       required: [status]
 *       properties:
 *         status:
 *           type: string
 *           enum: [approved, correction, rejected]
 *         remarks:
 *           type: string
 *           description: At least five trimmed characters for correction or rejection.
 *         expectedUpdatedAt:
 *           type: string
 *           format: date-time
 *           description: Required with fieldReviews. Use the exact updatedAt from the detail response; outdated reviews return 409.
 *         fieldReviews:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/KycFieldDecision'
 *           description: Approval requires an approved decision for every submitted field. Unknown, empty and duplicate fields are rejected.
 *     AssignableStaffRole:
 *       type: object
 *       properties:
 *         _id: { type: string }
 *         name: { type: string }
 *         description: { type: string }
 *         accountType:
 *           type: string
 *           description: Supported User.role value; custom roles use manager plus their roleId.
 *         permissions:
 *           type: array
 *           items: { type: string }
 * /api/admin/kyc:
 *   get:
 *     tags: [Admin]
 *     summary: List driver or rider KYC submissions
 *     description: Requires admin access and kyc:view. Includes all submitted fields and fieldReviews.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [driver, passenger], default: driver }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, submitted, approved, correction, rejected] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *     responses:
 *       200:
 *         description: data array, requirements array, kycType, and pagination (page, limit, total, pages).
 *       400: { description: Invalid account type or status }
 *       403: { description: Missing permission }
 * /api/admin/kyc/{type}/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: View all submitted KYC data and field review history
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema: { type: string, enum: [driver, passenger] }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: data contains full KYC record, populated user contact details, review metadata and updatedAt; requirements lists submitted-field keys. }
 *       400: { description: Invalid type or ID }
 *       403: { description: Missing kyc:view permission }
 *       404: { description: KYC not found }
 * /api/admin/kyc/{type}/{id}/review:
 *   patch:
 *     tags: [Admin]
 *     summary: Review individual KYC fields and overall submission
 *     description: Requires kyc:approve. The KYC record, account level and driver activation are committed together. Correction/rejection sets basic KYC and takes the account offline. Expired documents cannot be approved. Legacy whole-record clients remain supported unless unresolved field corrections exist.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema: { type: string, enum: [driver, passenger] }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/KycReviewRequest'
 *     responses:
 *       200: { description: Saved data, message and warnings array; referral failures do not turn a saved review into a failed response. }
 *       400: { description: Invalid decisions, missing approval or correction reasons, expired document, invalid version }
 *       403: { description: Missing kyc:approve permission }
 *       404: { description: KYC not found }
 *       409: { description: Submission changed or account no longer exists; refresh before retrying }
 *       500: { description: Transaction failed; no review changes committed }
 * /api/roles/permissions:
 *   get:
 *     tags: [Roles]
 *     summary: Get the complete system permission catalog
 *     description: Requires role:view. Returns every defined permission grouped by category, and grantable permissions for the current actor. Backend delegation validation still applies to combinations of permissions.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: data contains permissions, groups and grantable.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     permissions: { type: array, items: { type: string } }
 *                     grantable: { type: array, items: { type: string } }
 *                     groups:
 *                       type: object
 *                       additionalProperties: { type: array, items: { type: string } }
 * /api/roles/assignable:
 *   get:
 *     tags: [Roles]
 *     summary: List staff roles the current actor may assign
 *     description: Requires user:create or user:assign_role. Excludes roles that would grant privileges beyond the actor and protects superadmin ownership.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Allowed role options, including custom staff roles.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/AssignableStaffRole' }
 *       403: { description: User creation or role assignment permission required }
 * /api/admin/users:
 *   post:
 *     tags: [Admin]
 *     summary: Create rider, driver or staff account using an assignable role
 *     description: Requires user:create. For custom staff roles, send accountType from /roles/assignable as role, and that role record's _id as roleId. All effective permissions are checked against the actor's delegation authority.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, phone, password]
 *             properties:
 *               firstName: { type: string }
 *               lastName: { type: string }
 *               phone: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               role: { type: string, default: client }
 *               roleId: { type: string, description: Assignable staff role ID }
 *     responses:
 *       201: { description: User created }
 *       400: { description: Invalid role, roleId or account fields }
 *       403: { description: Cannot delegate requested role }
 *       409: { description: Existing identity }
 */
